import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getSupabaseAdminClient } from '../config/supabase';
import { authenticate, requireRole, AuthenticatedRequest } from '../middleware/auth';
import { AppError } from '../utils/errors';
import {
  createClientSchema,
  updateClientSchema,
  paginationSchema,
  uuidSchema,
} from '../types/schemas';
import type { Client } from '../types/database';

export async function clientRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();
  const supabase = getSupabaseAdminClient();

  // List clients
  server.get(
    '/',
    {
      preHandler: [authenticate],
      schema: {
        querystring: paginationSchema.extend({
          search: z.string().optional(),
          tag: z.string().optional(),
          has_appointments: z.coerce.boolean().optional(),
        }),
      },
    },
    async (request: AuthenticatedRequest, reply) => {
      const { page, limit, sort, order, search, tag, has_appointments } = request.query;

      let query = supabase
        .from('clients')
        .select('*', { count: 'exact' })
        .eq('tenant_id', request.user.tenant_id)
        .order(sort || 'name', { ascending: order === 'asc' });

      if (search) {
        query = query.or(`name.ilike.%${search}%,phone.ilike.%${search}%,email.ilike.%${search}%`);
      }

      if (tag) {
        query = query.contains('tags', [tag]);
      }

      if (has_appointments) {
        // This would require a subquery or join - simplified for now
      }

      const from = (page - 1) * limit;
      const to = from + limit - 1;
      query = query.range(from, to);

      const { data: clients, error, count } = await query;

      if (error) {
        throw AppError.internal('Erro ao listar clientes');
      }

      // Get all tags for filter
      const { data: allClients } = await supabase
        .from('clients')
        .select('tags')
        .eq('tenant_id', request.user.tenant_id);

      const allTags = [...new Set(allClients?.flatMap(c => c.tags) || [])];

      return {
        success: true,
        data: clients || [],
        tags: allTags,
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

  // Get client by ID
  server.get(
    '/:id',
    {
      preHandler: [authenticate],
      schema: {
        params: z.object({ id: uuidSchema }),
      },
    },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params;

      const { data: client, error } = await supabase
        .from('clients')
        .select('*')
        .eq('id', id)
        .eq('tenant_id', request.user.tenant_id)
        .single();

      if (error || !client) {
        throw AppError.notFound('Cliente não encontrado');
      }

      // Get appointment history
      const { data: appointments } = await supabase
        .from('appointments')
        .select(`
          *,
          service:services(id, name, price),
          professional:professionals(id, name)
        `)
        .eq('client_id', id)
        .eq('tenant_id', request.user.tenant_id)
        .order('starts_at', { ascending: false })
        .limit(20);

      return {
        success: true,
        data: {
          ...client,
          appointments: appointments || [],
        },
      };
    }
  );

  // Create client
  server.post(
    '/',
    {
      preHandler: [authenticate],
      schema: {
        body: createClientSchema,
      },
    },
    async (request: AuthenticatedRequest, reply) => {
      const input = request.body;

      // Normalize phone/WhatsApp
      const normalizePhone = (phone: string) => phone.replace(/\D/g, '');

      const phone = normalizePhone(input.phone);
      const whatsapp = input.whatsapp ? normalizePhone(input.whatsapp) : phone;

      // Check if client with same phone exists
      const { data: existing } = await supabase
        .from('clients')
        .select('id')
        .eq('tenant_id', request.user.tenant_id)
        .eq('phone', phone)
        .single();

      if (existing) {
        throw AppError.conflict('Já existe um cliente com este telefone');
      }

      const { data: client, error } = await supabase
        .from('clients')
        .insert({
          ...input,
          phone,
          whatsapp,
          tenant_id: request.user.tenant_id,
        })
        .select()
        .single();

      if (error) {
        throw AppError.internal('Erro ao criar cliente');
      }

      return reply.status(201).send({
        success: true,
        data: client,
        message: 'Cliente criado com sucesso',
      });
    }
  );

  // Update client
  server.patch(
    '/:id',
    {
      preHandler: [authenticate],
      schema: {
        params: z.object({ id: uuidSchema }),
        body: updateClientSchema,
      },
    },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params;
      const input = request.body;

      // Normalize phone/WhatsApp if provided
      const updateData = { ...input };
      if (input.phone) {
        updateData.phone = input.phone.replace(/\D/g, '');
      }
      if (input.whatsapp) {
        updateData.whatsapp = input.whatsapp.replace(/\D/g, '');
      }

      const { data: client, error } = await supabase
        .from('clients')
        .update(updateData)
        .eq('id', id)
        .eq('tenant_id', request.user.tenant_id)
        .select()
        .single();

      if (error) {
        throw AppError.internal('Erro ao atualizar cliente');
      }

      if (!client) {
        throw AppError.notFound('Cliente não encontrado');
      }

      return {
        success: true,
        data: client,
        message: 'Cliente atualizado com sucesso',
      };
    }
  );

  // Delete client
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

      // Check if client has appointments
      const { count } = await supabase
        .from('appointments')
        .select('*', { count: 'exact', head: true })
        .eq('client_id', id)
        .eq('tenant_id', request.user.tenant_id);

      if (count && count > 0) {
        throw AppError.badRequest('Não é possível excluir cliente com histórico de agendamentos');
      }

      const { error } = await supabase
        .from('clients')
        .delete()
        .eq('id', id)
        .eq('tenant_id', request.user.tenant_id);

      if (error) {
        throw AppError.internal('Erro ao excluir cliente');
      }

      return {
        success: true,
        message: 'Cliente excluído com sucesso',
      };
    }
  );

  // Get client stats
  server.get(
    '/:id/stats',
    {
      preHandler: [authenticate],
      schema: {
        params: z.object({ id: uuidSchema }),
      },
    },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params;

      const { data: client } = await supabase
        .from('clients')
        .select('total_appointments, total_spent, last_appointment_at, created_at')
        .eq('id', id)
        .eq('tenant_id', request.user.tenant_id)
        .single();

      if (!client) {
        throw AppError.notFound('Cliente não encontrado');
      }

      // Get favorite service
      const { data: favoriteService } = await supabase
        .from('appointments')
        .select('service_id, service:services(name)')
        .eq('client_id', id)
        .eq('tenant_id', request.user.tenant_id)
        .in('status', ['completed', 'confirmed']);

      const serviceCounts = (favoriteService || []).reduce((acc, appt) => {
        const name = appt.service?.name || 'Desconhecido';
        acc[name] = (acc[name] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      const topService = Object.entries(serviceCounts).sort((a, b) => b[1] - a[1])[0];

      // Get favorite professional
      const { data: favoriteProfessional } = await supabase
        .from('appointments')
        .select('professional_id, professional:professionals(name)')
        .eq('client_id', id)
        .eq('tenant_id', request.user.tenant_id)
        .in('status', ['completed', 'confirmed']);

      const profCounts = (favoriteProfessional || []).reduce((acc, appt) => {
        const name = appt.professional?.name || 'Desconhecido';
        acc[name] = (acc[name] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      const topProfessional = Object.entries(profCounts).sort((a, b) => b[1] - a[1])[0];

      return {
        success: true,
        data: {
          ...client,
          favorite_service: topService?.[0] || null,
          favorite_professional: topProfessional?.[0] || null,
        },
      };
    }
  );

  // Search clients (for appointment booking)
  server.get(
    '/search/:query',
    {
      preHandler: [authenticate],
      schema: {
        params: z.object({ query: z.string().min(2) }),
        querystring: z.object({ limit: z.coerce.number().int().positive().max(20).default(10) }),
      },
    },
    async (request: AuthenticatedRequest, reply) => {
      const { query } = request.params;
      const { limit } = request.query;

      const { data: clients, error } = await supabase
        .from('clients')
        .select('id, name, phone, whatsapp, email, avatar_url')
        .eq('tenant_id', request.user.tenant_id)
        .or(`name.ilike.%${query}%,phone.ilike.%${query}%,email.ilike.%${query}%`)
        .order('name')
        .limit(limit);

      if (error) {
        throw AppError.internal('Erro ao buscar clientes');
      }

      return {
        success: true,
        data: clients || [],
      };
    }
  );
}