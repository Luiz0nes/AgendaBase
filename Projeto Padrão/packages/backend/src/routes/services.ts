import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getSupabaseAdminClient } from '../config/supabase';
import { authenticate, requireRole, AuthenticatedRequest } from '../middleware/auth';
import { AppError } from '../utils/errors';
import {
  createServiceSchema,
  updateServiceSchema,
  paginationSchema,
  uuidSchema,
} from '../types/schemas';
import type { Service } from '../types/database';

export async function serviceRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();
  const supabase = getSupabaseAdminClient();

  // List services
  server.get(
    '/',
    {
      preHandler: [authenticate],
      schema: {
        querystring: paginationSchema.extend({
          is_active: z.coerce.boolean().optional(),
          category: z.string().optional(),
          professional_id: uuidSchema.optional(),
          search: z.string().optional(),
        }),
      },
    },
    async (request: AuthenticatedRequest, reply) => {
      const { page, limit, sort, order, is_active, category, professional_id, search } = request.query;

      let query = supabase
        .from('services')
        .select('*', { count: 'exact' })
        .eq('tenant_id', request.user.tenant_id)
        .order(sort || 'category', { ascending: order === 'asc', nullsFirst: false })
        .order('name', { ascending: true });

      if (is_active !== undefined) {
        query = query.eq('is_active', is_active);
      }

      if (category) {
        query = query.eq('category', category);
      }

      if (professional_id) {
        query = query.contains('professional_ids', [professional_id]);
      }

      if (search) {
        query = query.ilike('name', `%${search}%`);
      }

      const from = (page - 1) * limit;
      const to = from + limit - 1;
      query = query.range(from, to);

      const { data: services, error, count } = await query;

      if (error) {
        throw AppError.internal('Erro ao listar serviços');
      }

      // Get categories for filter
      const { data: categories } = await supabase
        .from('services')
        .select('category')
        .eq('tenant_id', request.user.tenant_id)
        .eq('is_active', true)
        .not('category', 'is', null);

      const uniqueCategories = [...new Set(categories?.map(c => c.category).filter(Boolean) || [])];

      return {
        success: true,
        data: services || [],
        categories: uniqueCategories,
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

  // Get service by ID
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

      const { data: service, error } = await supabase
        .from('services')
        .select(`
          *,
          professionals:professionals(id, name, avatar_url)
        `)
        .eq('id', id)
        .eq('tenant_id', request.user.tenant_id)
        .single();

      if (error || !service) {
        throw AppError.notFound('Serviço não encontrado');
      }

      return {
        success: true,
        data: service,
      };
    }
  );

  // Create service
  server.post(
    '/',
    {
      preHandler: [authenticate, requireRole('owner', 'admin')],
      schema: {
        body: createServiceSchema,
      },
    },
    async (request: AuthenticatedRequest, reply) => {
      const input = request.body;

      // Validate professional_ids belong to tenant
      if (input.professional_ids.length > 0) {
        const { data: professionals, error } = await supabase
          .from('professionals')
          .select('id')
          .eq('tenant_id', request.user.tenant_id)
          .in('id', input.professional_ids);

        if (error || (professionals?.length || 0) !== input.professional_ids.length) {
          throw AppError.badRequest('Um ou mais profissionais inválidos');
        }
      }

      const { data: service, error } = await supabase
        .from('services')
        .insert({
          ...input,
          tenant_id: request.user.tenant_id,
        })
        .select()
        .single();

      if (error) {
        throw AppError.internal('Erro ao criar serviço');
      }

      return reply.status(201).send({
        success: true,
        data: service,
        message: 'Serviço criado com sucesso',
      });
    }
  );

  // Update service
  server.patch(
    '/:id',
    {
      preHandler: [authenticate, requireRole('owner', 'admin')],
      schema: {
        params: z.object({ id: uuidSchema }),
        body: updateServiceSchema,
      },
    },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params;
      const input = request.body;

      // Validate professional_ids if provided
      if (input.professional_ids) {
        const { data: professionals, error } = await supabase
          .from('professionals')
          .select('id')
          .eq('tenant_id', request.user.tenant_id)
          .in('id', input.professional_ids);

        if (error || (professionals?.length || 0) !== input.professional_ids.length) {
          throw AppError.badRequest('Um ou mais profissionais inválidos');
        }
      }

      const { data: service, error } = await supabase
        .from('services')
        .update(input)
        .eq('id', id)
        .eq('tenant_id', request.user.tenant_id)
        .select()
        .single();

      if (error) {
        throw AppError.internal('Erro ao atualizar serviço');
      }

      if (!service) {
        throw AppError.notFound('Serviço não encontrado');
      }

      return {
        success: true,
        data: service,
        message: 'Serviço atualizado com sucesso',
      };
    }
  );

  // Delete service (soft delete)
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

      // Check if service has upcoming appointments
      const { count } = await supabase
        .from('appointments')
        .select('*', { count: 'exact', head: true })
        .eq('service_id', id)
        .eq('tenant_id', request.user.tenant_id)
        .gte('starts_at', new Date().toISOString())
        .in('status', ['pending', 'confirmed']);

      if (count && count > 0) {
        throw AppError.badRequest('Não é possível excluir serviço com agendamentos futuros');
      }

      const { error } = await supabase
        .from('services')
        .update({ is_active: false })
        .eq('id', id)
        .eq('tenant_id', request.user.tenant_id);

      if (error) {
        throw AppError.internal('Erro ao desativar serviço');
      }

      return {
        success: true,
        message: 'Serviço desativado com sucesso',
      };
    }
  );

  // Bulk update service order/category
  server.patch(
    '/bulk/reorder',
    {
      preHandler: [authenticate, requireRole('owner', 'admin')],
      schema: {
        body: z.object({
          services: z.array(z.object({
            id: uuidSchema,
            category: z.string().nullable().optional(),
            display_order: z.number().int().optional(),
          })),
        }),
      },
    },
    async (request: AuthenticatedRequest, reply) => {
      const { services } = request.body;

      // Update each service
      const updates = services.map(s =>
        supabase
          .from('services')
          .update({
            category: s.category,
            // display_order: s.display_order, // Add this column if needed
          })
          .eq('id', s.id)
          .eq('tenant_id', request.user.tenant_id)
      );

      await Promise.all(updates);

      return {
        success: true,
        message: 'Serviços reordenados com sucesso',
      };
    }
  );
}