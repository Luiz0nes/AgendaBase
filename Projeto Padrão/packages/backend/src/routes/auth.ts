import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getSupabaseAdminClient, getSupabaseClient } from '../config/supabase';
import { getEnv } from '../config/env';
import { AppError } from '../utils/errors';
import { loginSchema, registerSchema, resetPasswordSchema, updatePasswordSchema } from '../types/schemas';

export async function authRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();
  const supabase = getSupabaseAdminClient();
  const supabaseClient = getSupabaseClient();
  const env = getEnv();

  // Login
  server.post(
    '/login',
    {
      schema: {
        body: loginSchema,
      },
    },
    async (request, reply) => {
      const { email, password } = request.body;

      const { data, error } = await supabaseClient.auth.signInWithPassword({
        email,
        password,
      });

      if (error || !data.user) {
        throw AppError.unauthorized('Credenciais inválidas');
      }

      // Get user's tenant membership
      const { data: membership } = await supabase
        .from('tenant_members')
        .select('tenant_id, role, professional_id')
        .eq('user_id', data.user.id)
        .single();

      if (!membership) {
        throw AppError.forbidden('Usuário não pertence a nenhuma organização');
      }

      // Get tenant info
      const { data: tenant } = await supabase
        .from('tenants')
        .select('id, name, slug, type, primary_color, secondary_color, logo_url, settings')
        .eq('id', membership.tenant_id)
        .single();

      return {
        success: true,
        data: {
          user: {
            id: data.user.id,
            email: data.user.email,
            name: data.user.user_metadata?.name || '',
            avatar_url: data.user.user_metadata?.avatar_url || null,
          },
          session: {
            access_token: data.session?.access_token,
            refresh_token: data.session?.refresh_token,
            expires_at: data.session?.expires_at,
          },
          tenant: tenant ? {
            id: tenant.id,
            name: tenant.name,
            slug: tenant.slug,
            type: tenant.type,
            primary_color: tenant.primary_color,
            secondary_color: tenant.secondary_color,
            logo_url: tenant.logo_url,
            settings: tenant.settings,
          } : null,
          membership: {
            role: membership.role,
            professional_id: membership.professional_id,
          },
        },
        message: 'Login realizado com sucesso',
      };
    }
  );

  // Register (creates tenant + owner user)
  server.post(
    '/register',
    {
      schema: {
        body: registerSchema,
      },
    },
    async (request, reply) => {
      const input = request.body;

      // Check if slug is available
      const { data: existingTenant } = await supabase
        .from('tenants')
        .select('id')
        .eq('slug', input.tenant_slug)
        .single();

      if (existingTenant) {
        throw AppError.conflict('Este slug já está em uso');
      }

      // Create user in Supabase Auth
      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email: input.email,
        password: input.password,
        email_confirm: true,
        user_metadata: {
          name: input.name,
        },
      });

      if (authError || !authData.user) {
        throw AppError.internal('Erro ao criar usuário');
      }

      // Create tenant
      const defaultSettings = {
        working_hours: [
          { day_of_week: 0, open_time: '09:00', close_time: '18:00', is_closed: true },
          { day_of_week: 1, open_time: '09:00', close_time: '18:00', is_closed: false },
          { day_of_week: 2, open_time: '09:00', close_time: '18:00', is_closed: false },
          { day_of_week: 3, open_time: '09:00', close_time: '18:00', is_closed: false },
          { day_of_week: 4, open_time: '09:00', close_time: '18:00', is_closed: false },
          { day_of_week: 5, open_time: '09:00', close_time: '18:00', is_closed: false },
          { day_of_week: 6, open_time: '09:00', close_time: '14:00', is_closed: false },
        ],
        slot_duration_minutes: 30,
        advance_booking_days: 60,
        cancellation_hours: 2,
        reminder_hours_before: [24, 2],
        whatsapp_enabled: true,
        whatsapp_template_confirmed: null,
        whatsapp_template_reminder: null,
        whatsapp_template_cancelled: null,
        allow_online_booking: true,
        require_confirmation: false,
        custom_fields: [],
      };

      const { data: tenant, error: tenantError } = await supabase
        .from('tenants')
        .insert({
          name: input.tenant_name,
          slug: input.tenant_slug,
          type: input.tenant_type,
          primary_color: '#1a1a2e',
          secondary_color: '#16213e',
          settings: defaultSettings,
        })
        .select()
        .single();

      if (tenantError || !tenant) {
        // Rollback user creation
        await supabase.auth.admin.deleteUser(authData.user.id);
        throw AppError.internal('Erro ao criar organização');
      }

      // Create owner membership
      const { error: memberError } = await supabase
        .from('tenant_members')
        .insert({
          tenant_id: tenant.id,
          user_id: authData.user.id,
          role: 'owner',
        });

      if (memberError) {
        // Rollback
        await supabase.from('tenants').delete().eq('id', tenant.id);
        await supabase.auth.admin.deleteUser(authData.user.id);
        throw AppError.internal('Erro ao vincular usuário à organização');
      }

      // Create free subscription
      await supabase.from('tenant_subscriptions').insert({
        tenant_id: tenant.id,
        plan: 'free',
        status: 'active',
        current_period_start: new Date().toISOString(),
        current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      });

      // Sign in the user
      const { data: sessionData, error: sessionError } = await supabaseClient.auth.signInWithPassword({
        email: input.email,
        password: input.password,
      });

      if (sessionError) {
        throw AppError.internal('Erro ao criar sessão');
      }

      return reply.status(201).send({
        success: true,
        data: {
          user: {
            id: authData.user.id,
            email: authData.user.email,
            name: input.name,
          },
          session: {
            access_token: sessionData.session?.access_token,
            refresh_token: sessionData.session?.refresh_token,
            expires_at: sessionData.session?.expires_at,
          },
          tenant: {
            id: tenant.id,
            name: tenant.name,
            slug: tenant.slug,
            type: tenant.type,
            primary_color: tenant.primary_color,
            secondary_color: tenant.secondary_color,
            settings: tenant.settings,
          },
          membership: {
            role: 'owner',
            professional_id: null,
          },
        },
        message: 'Conta criada com sucesso',
      });
    }
  );

  // Refresh token
  server.post(
    '/refresh',
    {
      schema: {
        body: z.object({
          refresh_token: z.string(),
        }),
      },
    },
    async (request, reply) => {
      const { refresh_token } = request.body;

      const { data, error } = await supabaseClient.auth.refreshSession({
        refresh_token,
      });

      if (error || !data.session) {
        throw AppError.unauthorized('Token de atualização inválido');
      }

      return {
        success: true,
        data: {
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
          expires_at: data.session.expires_at,
        },
      };
    }
  );

  // Logout
  server.post(
    '/logout',
    async (request, reply) => {
      const authHeader = request.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        await supabaseClient.auth.signOut();
      }

      return {
        success: true,
        message: 'Logout realizado com sucesso',
      };
    }
  );

  // Get current user
  server.get(
    '/me',
    async (request, reply) => {
      const authHeader = request.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        throw AppError.unauthorized('Token não fornecido');
      }

      const token = authHeader.substring(7);
      const { data: { user }, error } = await supabaseClient.auth.getUser(token);

      if (error || !user) {
        throw AppError.unauthorized('Token inválido');
      }

      // Get membership
      const { data: membership } = await supabase
        .from('tenant_members')
        .select('tenant_id, role, professional_id, tenant:tenants(id, name, slug, type, primary_color, secondary_color, logo_url, settings)')
        .eq('user_id', user.id)
        .single();

      return {
        success: true,
        data: {
          user: {
            id: user.id,
            email: user.email,
            name: user.user_metadata?.name || '',
            avatar_url: user.user_metadata?.avatar_url || null,
            created_at: user.created_at,
          },
          membership: membership ? {
            tenant_id: membership.tenant_id,
            role: membership.role,
            professional_id: membership.professional_id,
            tenant: membership.tenant,
          } : null,
        },
      };
    }
  );

  // Update profile
  server.patch(
    '/profile',
    {
      schema: {
        body: z.object({
          name: z.string().min(2).max(100).optional(),
          avatar_url: z.string().url().optional().nullable(),
        }),
      },
    },
    async (request, reply) => {
      const authHeader = request.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        throw AppError.unauthorized('Token não fornecido');
      }

      const token = authHeader.substring(7);
      const { data: { user }, error } = await supabaseClient.auth.getUser(token);

      if (error || !user) {
        throw AppError.unauthorized('Token inválido');
      }

      const { name, avatar_url } = request.body;

      const { data, error: updateError } = await supabaseClient.auth.updateUser({
        data: {
          name: name || user.user_metadata?.name,
          avatar_url: avatar_url || user.user_metadata?.avatar_url,
        },
      });

      if (updateError) {
        throw AppError.internal('Erro ao atualizar perfil');
      }

      return {
        success: true,
        data: {
          user: {
            id: data.user.id,
            email: data.user.email,
            name: data.user.user_metadata?.name || '',
            avatar_url: data.user.user_metadata?.avatar_url || null,
          },
        },
        message: 'Perfil atualizado com sucesso',
      };
    }
  );

  // Change password
  server.post(
    '/change-password',
    {
      schema: {
        body: updatePasswordSchema,
      },
    },
    async (request, reply) => {
      const authHeader = request.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        throw AppError.unauthorized('Token não fornecido');
      }

      const token = authHeader.substring(7);
      const { data: { user }, error } = await supabaseClient.auth.getUser(token);

      if (error || !user) {
        throw AppError.unauthorized('Token inválido');
      }

      const { current_password, new_password } = request.body;

      // Verify current password by trying to sign in
      const { error: signInError } = await supabaseClient.auth.signInWithPassword({
        email: user.email!,
        password: current_password,
      });

      if (signInError) {
        throw AppError.unauthorized('Senha atual incorreta');
      }

      // Update password
      const { error: updateError } = await supabaseClient.auth.updateUser({
        password: new_password,
      });

      if (updateError) {
        throw AppError.internal('Erro ao alterar senha');
      }

      return {
        success: true,
        message: 'Senha alterada com sucesso',
      };
    }
  );

  // Request password reset
  server.post(
    '/forgot-password',
    {
      schema: {
        body: resetPasswordSchema,
      },
    },
    async (request, reply) => {
      const { email } = request.body;

      const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
        redirectTo: `${env.FRONTEND_URL}/auth/reset-password`,
      });

      // Don't reveal if email exists
      return {
        success: true,
        message: 'Se o email existir, você receberá instruções para redefinir a senha',
      };
    }
  );

  // Verify reset token (called from frontend after clicking email link)
  server.post(
    '/verify-reset-token',
    {
      schema: {
        body: z.object({
          token: z.string(),
          type: z.string().default('recovery'),
        }),
      },
    },
    async (request, reply) => {
      const { token, type } = request.body;

      const { data, error } = await supabaseClient.auth.verifyOtp({
        token_hash: token,
        type: type as any,
      });

      if (error || !data.user) {
        throw AppError.badRequest('Token inválido ou expirado');
      }

      return {
        success: true,
        data: {
          user_id: data.user.id,
        },
      };
    }
  );

  // Reset password with token
  server.post(
    '/reset-password',
    {
      schema: {
        body: z.object({
          token: z.string(),
          password: z.string().min(8),
        }),
      },
    },
    async (request, reply) => {
      const { token, password } = request.body;

      const { error } = await supabaseClient.auth.verifyOtp({
        token_hash: token,
        type: 'recovery',
      });

      if (error) {
        throw AppError.badRequest('Token inválido ou expirado');
      }

      const { error: updateError } = await supabaseClient.auth.updateUser({
        password,
      });

      if (updateError) {
        throw AppError.internal('Erro ao redefinir senha');
      }

      return {
        success: true,
        message: 'Senha redefinida com sucesso',
      };
    }
  );
}