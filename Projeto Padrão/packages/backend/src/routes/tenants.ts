import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getSupabaseAdminClient } from '../config/supabase';
import { getEvolutionClient, getInstanceStatus } from '../config/evolution';
import { authenticate, requireRole, AuthenticatedRequest } from '../middleware/auth';
import { AppError } from '../utils/errors';
import {
  createTenantSchema,
  updateTenantSchema,
  tenantSettingsSchema,
  paginationSchema,
  uuidSchema,
} from '../types/schemas';
import type { Tenant, TenantSettings, TenantType } from '../types/database';

export async function tenantRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();
  const supabase = getSupabaseAdminClient();

  // Get current user's tenant
  server.get(
    '/me',
    { preHandler: [authenticate] },
    async (request: AuthenticatedRequest, reply) => {
      const { data: tenant, error } = await supabase
        .from('tenants')
        .select('*')
        .eq('id', request.user.tenant_id)
        .single();

      if (error || !tenant) {
        throw AppError.notFound('Organização não encontrada');
      }

      // Get subscription info
      const { data: subscription } = await supabase
        .from('tenant_subscriptions')
        .select('*')
        .eq('tenant_id', tenant.id)
        .single();

      // Get member count
      const { count: memberCount } = await supabase
        .from('tenant_members')
        .select('*', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id);

      // Get professional count
      const { count: professionalCount } = await supabase
        .from('professionals')
        .select('*', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .eq('is_active', true);

      // Get client count
      const { count: clientCount } = await supabase
        .from('clients')
        .select('*', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id);

      // Get appointment stats for current month
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);

      const { count: appointmentsThisMonth } = await supabase
        .from('appointments')
        .select('*', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .gte('starts_at', startOfMonth.toISOString())
        .lte('starts_at', endOfMonth.toISOString())
        .in('status', ['confirmed', 'completed']);

      return {
        success: true,
        data: {
          ...tenant,
          subscription,
          stats: {
            members: memberCount || 0,
            professionals: professionalCount || 0,
            clients: clientCount || 0,
            appointments_this_month: appointmentsThisMonth || 0,
          },
        },
      };
    }
  );

  // Get tenant by slug (public - for booking page)
  server.get(
    '/public/:slug',
    {
      schema: {
        params: z.object({ slug: z.string() }),
      },
    },
    async (request, reply) => {
      const { slug } = request.params;

      const { data: tenant, error } = await supabase
        .from('tenants')
        .select(`
          id, name, slug, type, logo_url, primary_color, secondary_color,
          address, phone, email, description, settings, created_at
        `)
        .eq('slug', slug)
        .single();

      if (error || !tenant) {
        throw AppError.notFound('Organização não encontrada');
      }

      // Get active professionals for booking
      const { data: professionals } = await supabase
        .from('professionals')
        .select('id, name, avatar_url, specialties, bio')
        .eq('tenant_id', tenant.id)
        .eq('is_active', true)
        .order('name');

      // Get active services grouped by category
      const { data: services } = await supabase
        .from('services')
        .select('id, name, description, duration_minutes, price, category, color, professional_ids')
        .eq('tenant_id', tenant.id)
        .eq('is_active', true)
        .order('category', { ascending: true, nullsFirst: false })
        .order('name');

      return {
        success: true,
        data: {
          ...tenant,
          professionals: professionals || [],
          services: services || [],
        },
      };
    }
  );

  // Create tenant (public - for registration)
  server.post(
    '/',
    {
      schema: {
        body: createTenantSchema,
      },
    },
    async (request, reply) => {
      const input = request.body;

      // Check if slug is available
      const { data: existing } = await supabase
        .from('tenants')
        .select('id')
        .eq('slug', input.slug)
        .single();

      if (existing) {
        throw AppError.conflict('Este slug já está em uso');
      }

      const defaultSettings: TenantSettings = {
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

      const { data: tenant, error } = await supabase
        .from('tenants')
        .insert({
          ...input,
          settings: defaultSettings,
        })
        .select()
        .single();

      if (error) {
        throw AppError.internal('Erro ao criar organização');
      }

      // Create free subscription
      await supabase.from('tenant_subscriptions').insert({
        tenant_id: tenant.id,
        plan: 'free',
        status: 'active',
        current_period_start: new Date().toISOString(),
        current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      });

      return reply.status(201).send({
        success: true,
        data: tenant,
        message: 'Organização criada com sucesso',
      });
    }
  );

  // Update tenant
  server.patch(
    '/:id',
    {
      preHandler: [authenticate, requireRole('owner', 'admin')],
      schema: {
        params: z.object({ id: uuidSchema }),
        body: updateTenantSchema,
      },
    },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params;
      const input = request.body;

      if (request.user.tenant_id !== id) {
        throw AppError.forbidden('Acesso negado');
      }

      // Check slug uniqueness if changing
      if (input.slug) {
        const { data: existing } = await supabase
          .from('tenants')
          .select('id')
          .eq('slug', input.slug)
          .neq('id', id)
          .single();

        if (existing) {
          throw AppError.conflict('Este slug já está em uso');
        }
      }

      const { data: tenant, error } = await supabase
        .from('tenants')
        .update(input)
        .eq('id', id)
        .select()
        .single();

      if (error) {
        throw AppError.internal('Erro ao atualizar organização');
      }

      return {
        success: true,
        data: tenant,
        message: 'Organização atualizada com sucesso',
      };
    }
  );

  // Update tenant settings
  server.patch(
    '/:id/settings',
    {
      preHandler: [authenticate, requireRole('owner', 'admin')],
      schema: {
        params: z.object({ id: uuidSchema }),
        body: tenantSettingsSchema,
      },
    },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params;
      const input = request.body;

      if (request.user.tenant_id !== id) {
        throw AppError.forbidden('Acesso negado');
      }

      const { data: tenant, error } = await supabase
        .from('tenants')
        .update({ settings: input })
        .eq('id', id)
        .select()
        .single();

      if (error) {
        throw AppError.internal('Erro ao atualizar configurações');
      }

      return {
        success: true,
        data: tenant.settings,
        message: 'Configurações atualizadas com sucesso',
      };
    }
  );

  // Get tenant settings
  server.get(
    '/:id/settings',
    {
      preHandler: [authenticate],
      schema: {
        params: z.object({ id: uuidSchema }),
      },
    },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params;

      if (request.user.tenant_id !== id) {
        throw AppError.forbidden('Acesso negado');
      }

      const { data: tenant, error } = await supabase
        .from('tenants')
        .select('settings')
        .eq('id', id)
        .single();

      if (error || !tenant) {
        throw AppError.notFound('Organização não encontrada');
      }

      return {
        success: true,
        data: tenant.settings,
      };
    }
  );

  // Check Evolution API connection
  server.get(
    '/:id/whatsapp/status',
    {
      preHandler: [authenticate, requireRole('owner', 'admin')],
      schema: {
        params: z.object({ id: uuidSchema }),
      },
    },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params;

      if (request.user.tenant_id !== id) {
        throw AppError.forbidden('Acesso negado');
      }

      try {
        const status = await getInstanceStatus();
        return {
          success: true,
          data: { connected: status.state === 'open', state: status.state },
        };
      } catch (error) {
        return {
          success: true,
          data: { connected: false, state: 'disconnected', error: 'Falha ao conectar' },
        };
      }
    }
  );

  // Test WhatsApp message
  server.post(
    '/:id/whatsapp/test',
    {
      preHandler: [authenticate, requireRole('owner', 'admin')],
      schema: {
        params: z.object({ id: uuidSchema }),
        body: z.object({
          phone: z.string().min(10),
          message: z.string().optional(),
        }),
      },
    },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params;
      const { phone, message } = request.body;

      if (request.user.tenant_id !== id) {
        throw AppError.forbidden('Acesso negado');
      }

      try {
        const { sendTextMessage } = await import('../config/evolution');
        await sendTextMessage({
          number: phone,
          text: message || '🧪 Teste de integração WhatsApp - Agenda Pro',
        });

        return {
          success: true,
          message: 'Mensagem de teste enviada com sucesso',
        };
      } catch (error) {
        throw AppError.internal('Erro ao enviar mensagem de teste');
      }
    }
  );

  // Delete tenant (owner only)
  server.delete(
    '/:id',
    {
      preHandler: [authenticate, requireRole('owner')],
      schema: {
        params: z.object({ id: uuidSchema }),
      },
    },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params;

      if (request.user.tenant_id !== id) {
        throw AppError.forbidden('Acesso negado');
      }

      // Soft delete - mark as deleted
      const { error } = await supabase
        .from('tenants')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', id);

      if (error) {
        throw AppError.internal('Erro ao excluir organização');
      }

      return {
        success: true,
        message: 'Organização excluída com sucesso',
      };
    }
  );
}