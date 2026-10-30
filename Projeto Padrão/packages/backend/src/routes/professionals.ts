import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getSupabaseAdminClient } from '../config/supabase';
import { authenticate, requireRole, AuthenticatedRequest } from '../middleware/auth';
import { AppError } from '../utils/errors';
import {
  createProfessionalSchema,
  updateProfessionalSchema,
  paginationSchema,
  uuidSchema,
} from '../types/schemas';
import type { Professional, WorkingHours } from '../types/database';

export async function professionalRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();
  const supabase = getSupabaseAdminClient();

  // List professionals
  server.get(
    '/',
    {
      preHandler: [authenticate],
      schema: {
        querystring: paginationSchema.extend({
          is_active: z.coerce.boolean().optional(),
          search: z.string().optional(),
        }),
      },
    },
    async (request: AuthenticatedRequest, reply) => {
      const { page, limit, sort, order, is_active, search } = request.query;

      let query = supabase
        .from('professionals')
        .select('*', { count: 'exact' })
        .eq('tenant_id', request.user.tenant_id)
        .order(sort || 'name', { ascending: order === 'asc' });

      if (is_active !== undefined) {
        query = query.eq('is_active', is_active);
      }

      if (search) {
        query = query.ilike('name', `%${search}%`);
      }

      const from = (page - 1) * limit;
      const to = from + limit - 1;
      query = query.range(from, to);

      const { data: professionals, error, count } = await query;

      if (error) {
        throw AppError.internal('Erro ao listar profissionais');
      }

      return {
        success: true,
        data: professionals || [],
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

  // Get professional by ID
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

      const { data: professional, error } = await supabase
        .from('professionals')
        .select('*')
        .eq('id', id)
        .eq('tenant_id', request.user.tenant_id)
        .single();

      if (error || !professional) {
        throw AppError.notFound('Profissional não encontrado');
      }

      // Get associated services
      const { data: services } = await supabase
        .from('services')
        .select('id, name, duration_minutes, price, category')
        .eq('tenant_id', request.user.tenant_id)
        .contains('professional_ids', [id])
        .eq('is_active', true);

      return {
        success: true,
        data: {
          ...professional,
          services: services || [],
        },
      };
    }
  );

  // Create professional
  server.post(
    '/',
    {
      preHandler: [authenticate, requireRole('owner', 'admin')],
      schema: {
        body: createProfessionalSchema,
      },
    },
    async (request: AuthenticatedRequest, reply) => {
      const input = request.body;

      // Validate working hours
      const workingHours = input.working_hours;
      for (const wh of workingHours) {
        if (!wh.is_closed) {
          const [openH, openM] = wh.open_time.split(':').map(Number);
          const [closeH, closeM] = wh.close_time.split(':').map(Number);
          if (openH * 60 + openM >= closeH * 60 + closeM) {
            throw AppError.badRequest(`Horário inválido para dia ${wh.day_of_week}`);
          }
        }
      }

      const { data: professional, error } = await supabase
        .from('professionals')
        .insert({
          ...input,
          tenant_id: request.user.tenant_id,
        })
        .select()
        .single();

      if (error) {
        throw AppError.internal('Erro ao criar profissional');
      }

      return reply.status(201).send({
        success: true,
        data: professional,
        message: 'Profissional criado com sucesso',
      });
    }
  );

  // Update professional
  server.patch(
    '/:id',
    {
      preHandler: [authenticate, requireRole('owner', 'admin')],
      schema: {
        params: z.object({ id: uuidSchema }),
        body: updateProfessionalSchema,
      },
    },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params;
      const input = request.body;

      // Validate working hours if provided
      if (input.working_hours) {
        for (const wh of input.working_hours) {
          if (!wh.is_closed) {
            const [openH, openM] = wh.open_time.split(':').map(Number);
            const [closeH, closeM] = wh.close_time.split(':').map(Number);
            if (openH * 60 + openM >= closeH * 60 + closeM) {
              throw AppError.badRequest(`Horário inválido para dia ${wh.day_of_week}`);
            }
          }
        }
      }

      const { data: professional, error } = await supabase
        .from('professionals')
        .update(input)
        .eq('id', id)
        .eq('tenant_id', request.user.tenant_id)
        .select()
        .single();

      if (error) {
        throw AppError.internal('Erro ao atualizar profissional');
      }

      if (!professional) {
        throw AppError.notFound('Profissional não encontrado');
      }

      return {
        success: true,
        data: professional,
        message: 'Profissional atualizado com sucesso',
      };
    }
  );

  // Delete professional (soft delete)
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

      // Check if professional has upcoming appointments
      const { count } = await supabase
        .from('appointments')
        .select('*', { count: 'exact', head: true })
        .eq('professional_id', id)
        .eq('tenant_id', request.user.tenant_id)
        .gte('starts_at', new Date().toISOString())
        .in('status', ['pending', 'confirmed']);

      if (count && count > 0) {
        throw AppError.badRequest('Não é possível excluir profissional com agendamentos futuros');
      }

      const { error } = await supabase
        .from('professionals')
        .update({ is_active: false })
        .eq('id', id)
        .eq('tenant_id', request.user.tenant_id);

      if (error) {
        throw AppError.internal('Erro ao desativar profissional');
      }

      return {
        success: true,
        message: 'Profissional desativado com sucesso',
      };
    }
  );

  // Get professional schedule for a date range
  server.get(
    '/:id/schedule',
    {
      preHandler: [authenticate],
      schema: {
        params: z.object({ id: uuidSchema }),
        querystring: z.object({
          start_date: z.string().date(),
          end_date: z.string().date(),
        }),
      },
    },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params;
      const { start_date, end_date } = request.query;

      const { data: professional, error } = await supabase
        .from('professionals')
        .select('working_hours')
        .eq('id', id)
        .eq('tenant_id', request.user.tenant_id)
        .single();

      if (error || !professional) {
        throw AppError.notFound('Profissional não encontrado');
      }

      // Get appointments in range
      const { data: appointments } = await supabase
        .from('appointments')
        .select('id, starts_at, ends_at, status, service_id, client_id')
        .eq('professional_id', id)
        .eq('tenant_id', request.user.tenant_id)
        .gte('starts_at', start_date)
        .lte('starts_at', end_date)
        .in('status', ['pending', 'confirmed', 'completed']);

      return {
        success: true,
        data: {
          working_hours: professional.working_hours,
          appointments: appointments || [],
        },
      };
    }
  );

  // Get professional availability for a specific date
  server.get(
    '/:id/availability',
    {
      preHandler: [authenticate],
      schema: {
        params: z.object({ id: uuidSchema }),
        querystring: z.object({
          service_id: uuidSchema,
          date: z.string().date(),
        }),
      },
    },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params;
      const { service_id, date } = request.query;

      // Get professional
      const { data: professional, error: profError } = await supabase
        .from('professionals')
        .select('working_hours')
        .eq('id', id)
        .eq('tenant_id', request.user.tenant_id)
        .single();

      if (profError || !professional) {
        throw AppError.notFound('Profissional não encontrado');
      }

      // Get service
      const { data: service, error: serviceError } = await supabase
        .from('services')
        .select('duration_minutes, preparation_minutes')
        .eq('id', service_id)
        .eq('tenant_id', request.user.tenant_id)
        .single();

      if (serviceError || !service) {
        throw AppError.notFound('Serviço não encontrado');
      }

      // Check if professional can perform this service
      const { data: serviceCheck } = await supabase
        .from('services')
        .select('id')
        .eq('id', service_id)
        .contains('professional_ids', [id])
        .single();

      if (!serviceCheck) {
        throw AppError.badRequest('Este profissional não realiza este serviço');
      }

      // Get tenant settings for slot duration
      const { data: tenant } = await supabase
        .from('tenants')
        .select('settings')
        .eq('id', request.user.tenant_id)
        .single();

      const slotDuration = tenant?.settings?.slot_duration_minutes || 30;

      // Get appointments for the date
      const startOfDay = new Date(`${date}T00:00:00`);
      const endOfDay = new Date(`${date}T23:59:59`);

      const { data: appointments } = await supabase
        .from('appointments')
        .select('starts_at, ends_at')
        .eq('professional_id', id)
        .eq('tenant_id', request.user.tenant_id)
        .gte('starts_at', startOfDay.toISOString())
        .lte('starts_at', endOfDay.toISOString())
        .in('status', ['pending', 'confirmed']);

      // Get working hours for the date
      const dayOfWeek = new Date(date).getDay();
      const workingHours = professional.working_hours.find((wh: WorkingHours) => wh.day_of_week === dayOfWeek);

      if (!workingHours || workingHours.is_closed) {
        return {
          success: true,
          data: {
            date,
            slots: [],
            is_closed: true,
          },
        };
      }

      // Generate time slots
      const slots = generateTimeSlots(
        workingHours,
        slotDuration,
        appointments || [],
        service.preparation_minutes
      );

      return {
        success: true,
        data: {
          date,
          slots,
          is_closed: false,
        },
      };
    }
  );
}

// Helper function to generate time slots (copied from date.ts for now)
function generateTimeSlots(
  workingHours: WorkingHours,
  slotDurationMinutes: number,
  existingAppointments: Array<{ starts_at: string; ends_at: string }> = [],
  preparationMinutes: number = 0
): Array<{ start: string; end: string; available: boolean }> {
  if (workingHours.is_closed) return [];

  const slots: Array<{ start: string; end: string; available: boolean }> = [];
  const [openHour, openMinute] = workingHours.open_time.split(':').map(Number);
  const [closeHour, closeMinute] = workingHours.close_time.split(':').map(Number);

  let currentMinutes = openHour * 60 + openMinute;
  const closeMinutes = closeHour * 60 + closeMinute;

  while (currentMinutes + slotDurationMinutes <= closeMinutes) {
    const slotStart = currentMinutes;
    const slotEnd = currentMinutes + slotDurationMinutes;

    // Check if slot is during a break
    const isBreak = workingHours.breaks?.some(breakTime => {
      const [breakStartHour, breakStartMinute] = breakTime.start.split(':').map(Number);
      const [breakEndHour, breakEndMinute] = breakTime.end.split(':').map(Number);
      const breakStartMinutes = breakStartHour * 60 + breakStartMinute;
      const breakEndMinutes = breakEndHour * 60 + breakEndMinute;
      return slotStart >= breakStartMinutes && slotEnd <= breakEndMinutes;
    }) ?? false;

    // Check if slot conflicts with existing appointments
    const hasConflict = existingAppointments.some(appt => {
      const apptStart = new Date(appt.starts_at);
      const apptEnd = new Date(appt.ends_at);
      const apptStartMinutes = apptStart.getHours() * 60 + apptStart.getMinutes();
      const apptEndMinutes = apptEnd.getHours() * 60 + apptEnd.getMinutes();

      const prepStartMinutes = apptStartMinutes - preparationMinutes;

      return slotStart < apptEndMinutes && slotEnd > prepStartMinutes;
    });

    const startStr = `${String(Math.floor(slotStart / 60)).padStart(2, '0')}:${String(slotStart % 60).padStart(2, '0')}`;
    const endStr = `${String(Math.floor(slotEnd / 60)).padStart(2, '0')}:${String(slotEnd % 60).padStart(2, '0')}`;

    slots.push({
      start: startStr,
      end: endStr,
      available: !isBreak && !hasConflict,
    });

    currentMinutes += slotDurationMinutes;
  }

  return slots;
}