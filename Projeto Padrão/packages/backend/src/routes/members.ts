import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getSupabaseAdminClient } from '../config/supabase';
import { authenticate, requireRole, AuthenticatedRequest } from '../middleware/auth';
import { AppError } from '../utils/errors';
import {
  inviteMemberSchema,
  updateMemberSchema,
  paginationSchema,
  uuidSchema,
} from '../types/schemas';
import type { TenantMember, MemberRole } from '../types/database';

export async function memberRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();
  const supabase = getSupabaseAdminClient();

  // List members
  server.get(
    '/',
    {
      preHandler: [authenticate, requireRole('owner', 'admin')],
      schema: {
        querystring: paginationSchema,
      },
    },
    async (request: AuthenticatedRequest, reply) => {
      const { page, limit, sort, order } = request.query;

      let query = supabase
        .from('tenant_members')
        .select(`
          *,
          user:users(id, email, created_at),
          professional:professionals(id, name, avatar_url)
        `, { count: 'exact' })
        .eq('tenant_id', request.user.tenant_id)
        .order(sort || 'created_at', { ascending: order === 'asc' });

      const from = (page - 1) * limit;
      const to = from + limit - 1;
      query = query.range(from, to);

      const { data: members, error, count } = await query;

      if (error) {
        throw AppError.internal('Erro ao listar membros');
      }

      return {
        success: true,
        data: members || [],
        pagination: {
          page,
          limit,
          total: count || 0,
          totalPages: Math.ceil((count || 0) / limit),
          hasNext: page < Math.ceil((count || 0) / limit),
          hasPrev: page > 1,
        },
      };
    }
  );

  // Invite member
  server.post(
    '/invite',
    {
      preHandler: [authenticate, requireRole('owner', 'admin')],
      schema: {
        body: inviteMemberSchema,
      },
    },
    async (request: AuthenticatedRequest, reply) => {
      const input = request.body;

      // Check if user already exists in Supabase Auth
      const { data: { users } } = await supabase.auth.admin.listUsers();
      const existingUser = users.find(u => u.email === input.email);

      let userId: string;

      if (existingUser) {
        userId = existingUser.id;

        // Check if already a member
        const { data: existingMember } = await supabase
          .from('tenant_members')
          .select('id')
          .eq('tenant_id', request.user.tenant_id)
          .eq('user_id', userId)
          .single();

        if (existingMember) {
          throw AppError.conflict('Este usuário já é membro da organização');
        }
      } else {
        // Invite user via Supabase Auth
        const { data: inviteData, error: inviteError } = await supabase.auth.admin.inviteUserByEmail(input.email, {
          redirectTo: `${process.env.FRONTEND_URL}/auth/accept-invite`,
          data: {
            tenant_id: request.user.tenant_id,
            role: input.role,
          },
        });

        if (inviteError) {
          throw AppError.internal('Erro ao convidar usuário');
        }

        userId = inviteData.user.id;
      }

      // Validate professional if provided
      if (input.professional_id) {
        const { data: professional, error } = await supabase
          .from('professionals')
          .select('id')
          .eq('id', input.professional_id)
          .eq('tenant_id', request.user.tenant_id)
          .single();

        if (error || !professional) {
          throw AppError.badRequest('Profissional inválido');
        }
      }

      // Create member
      const { data: member, error } = await supabase
        .from('tenant_members')
        .insert({
          tenant_id: request.user.tenant_id,
          user_id: userId,
          role: input.role,
          professional_id: input.professional_id || null,
        })
        .select(`
          *,
          user:users(id, email, created_at),
          professional:professionals(id, name, avatar_url)
        `)
        .single();

      if (error) {
        throw AppError.internal('Erro ao adicionar membro');
      }

      return reply.status(201).send({
        success: true,
        data: member,
        message: 'Convite enviado com sucesso',
      });
    }
  );

  // Update member
  server.patch(
    '/:id',
    {
      preHandler: [authenticate, requireRole('owner', 'admin')],
      schema: {
        params: z.object({ id: uuidSchema }),
        body: updateMemberSchema,
      },
    },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params;
      const input = request.body;

      // Prevent owner from demoting themselves
      const { data: currentMember } = await supabase
        .from('tenant_members')
        .select('user_id, role')
        .eq('id', id)
        .single();

      if (currentMember?.user_id === request.user.id && input.role && input.role !== 'owner') {
        throw AppError.badRequest('Não é possível alterar sua própria função de proprietário');
      }

      // Validate professional if provided
      if (input.professional_id) {
        const { data: professional, error } = await supabase
          .from('professionals')
          .select('id')
          .eq('id', input.professional_id)
          .eq('tenant_id', request.user.tenant_id)
          .single();

        if (error || !professional) {
          throw AppError.badRequest('Profissional inválido');
        }
      }

      const { data: member, error } = await supabase
        .from('tenant_members')
        .update(input)
        .eq('id', id)
        .eq('tenant_id', request.user.tenant_id)
        .select(`
          *,
          user:users(id, email, created_at),
          professional:professionals(id, name, avatar_url)
        `)
        .single();

      if (error) {
        throw AppError.internal('Erro ao atualizar membro');
      }

      if (!member) {
        throw AppError.notFound('Membro não encontrado');
      }

      return {
        success: true,
        data: member,
        message: 'Membro atualizado com sucesso',
      };
    }
  );

  // Remove member
  server.delete(
    '/:id',
    {
      preHandler: [authenticate, requireRole('owner', 'admin')],
      schema: {
        params: z.object({ id: uuidSchema }),
      },
    },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params;

      // Prevent owner from removing themselves
      const { data: currentMember } = await supabase
        .from('tenant_members')
        .select('user_id, role')
        .eq('id', id)
        .single();

      if (currentMember?.user_id === request.user.id) {
        throw AppError.badRequest('Não é possível remover a si mesmo');
      }

      const { error } = await supabase
        .from('tenant_members')
        .delete()
        .eq('id', id)
        .eq('tenant_id', request.user.tenant_id);

      if (error) {
        throw AppError.internal('Erro ao remover membro');
      }

      return {
        success: true,
        message: 'Membro removido com sucesso',
      };
    }
  );

  // Resend invite
  server.post(
    '/:id/resend-invite',
    {
      preHandler: [authenticate, requireRole('owner', 'admin')],
      schema: {
        params: z.object({ id: uuidSchema }),
      },
    },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params;

      const { data: member } = await supabase
        .from('tenant_members')
        .select('user_id')
        .eq('id', id)
        .eq('tenant_id', request.user.tenant_id)
        .single();

      if (!member) {
        throw AppError.notFound('Membro não encontrado');
      }

      const { data: { user } } = await supabase.auth.admin.getUserById(member.user_id);

      if (!user) {
        throw AppError.notFound('Usuário não encontrado');
      }

      const { error } = await supabase.auth.admin.inviteUserByEmail(user.email!, {
        redirectTo: `${process.env.FRONTEND_URL}/auth/accept-invite`,
        data: {
          tenant_id: request.user.tenant_id,
          role: member.role,
        },
      });

      if (error) {
        throw AppError.internal('Erro ao reenviar convite');
      }

      return {
        success: true,
        message: 'Convite reenviado com sucesso',
      };
    }
  );
}