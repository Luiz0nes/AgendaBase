import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getSupabaseAdminClient } from '../config/supabase';
import { sendTextMessage, WHATSAPP_TEMPLATES } from '../config/evolution';
import { authenticate, requireRole, AuthenticatedRequest } from '../middleware/auth';
import { AppError } from '../utils/errors';
import {
  createAppointmentSchema,
  updateAppointmentSchema,
  rescheduleAppointmentSchema,
  paginationSchema,
  uuidSchema,
  availabilityQuerySchema,
  bulkAvailabilitySchema,
} from '../types/schemas';
import { formatDate, formatTime, getWorkingHoursForDate, isSlotAvailable } from '../utils/date';
import type { Appointment, AppointmentStatus, WorkingHours } from '../types/database';

export async function appointmentRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();
  const supabase = getSupabaseAdminClient();

  // List appointments
  server.get(
    '/',
    {
      preHandler: [authenticate],
      schema: {
        querystring: paginationSchema.extend({
          status: z.enum(['pending', 'confirmed', 'cancelled', 'completed', 'no_show', 'rescheduled']).optional(),
          professional_id: uuidSchema.optional(),
          client_id: uuidSchema.optional(),
          service_id: uuidSchema.optional(),
          start_date: z.string().date().optional(),
          end_date: z.string().date().optional(),
        }),
      },
    },
    async (request: AuthenticatedRequest, reply) => {
      const { page, limit, sort, order, status, professional_id, client_id, service_id, start_date, end_date } = request.query;

      let query = supabase
        .from('appointments')
        .select(`
          *,
          client:clients(id, name, phone, whatsapp, email),
          professional:professionals(id, name, avatar_url),
          service:services(id, name, duration_minutes, price, color)
        `, { count: 'exact' })
        .eq('tenant_id', request.user.tenant_id)
        .order(sort || 'starts_at', { ascending: order === 'asc' });

      if (status) {
        query = query.eq('status', status);
      }

      if (professional_id) {
        query = query.eq('professional_id', professional_id);
      }

      if (client_id) {
        query = query.eq('client_id', client_id);
      }

      if (service_id) {
        query = query.eq('service_id', service_id);
      }

      if (start_date) {
        query = query.gte('starts_at', start_date);
      }

      if (end_date) {
        query = query.lte('starts_at', end_date);
      }

      // Professionals can only see their own appointments
      if (request.user.role === 'professional' && request.user.professional_id) {
        query = query.eq('professional_id', request.user.professional_id);
      }

      const from = (page - 1) * limit;
      const to = from + limit - 1;
      query = query.range(from, to);

      const { data: appointments, error, count } = await query;

      if (error) {
        throw AppError.internal('Erro ao listar agendamentos');
      }

      return {
        success: true,
        data: appointments || [],
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

  // Get appointment by ID
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

      const { data: appointment, error } = await supabase
        .from('appointments')
        .select(`
          *,
          client:clients(id, name, phone, whatsapp, email, notes),
          professional:professionals(id, name, avatar_url, phone),
          service:services(id, name, duration_minutes, price, color)
        `)
        .eq('id', id)
        .eq('tenant_id', request.user.tenant_id)
        .single();

      if (error || !appointment) {
        throw AppError.notFound('Agendamento não encontrado');
      }

      // Check professional access
      if (request.user.role === 'professional' && request.user.professional_id !== appointment.professional_id) {
        throw AppError.forbidden('Acesso negado');
      }

      return {
        success: true,
        data: appointment,
      };
    }
  );

  // Create appointment
  server.post(
    '/',
    {
      preHandler: [authenticate],
      schema: {
        body: createAppointmentSchema,
      },
    },
    async (request: AuthenticatedRequest, reply) => {
      const input = request.body;

      // Validate client belongs to tenant
      const { data: client, error: clientError } = await supabase
        .from('clients')
        .select('id, name, phone, whatsapp')
        .eq('id', input.client_id)
        .eq('tenant_id', request.user.tenant_id)
        .single();

      if (clientError || !client) {
        throw AppError.notFound('Cliente não encontrado');
      }

      // Validate professional
      const { data: professional, error: profError } = await supabase
        .from('professionals')
        .select('id, name, working_hours')
        .eq('id', input.professional_id)
        .eq('tenant_id', request.user.tenant_id)
        .eq('is_active', true)
        .single();

      if (profError || !professional) {
        throw AppError.notFound('Profissional não encontrado');
      }

      // Validate service
      const { data: service, error: serviceError } = await supabase
        .from('services')
        .select('id, name, duration_minutes, price, professional_ids, preparation_minutes')
        .eq('id', input.service_id)
        .eq('tenant_id', request.user.tenant_id)
        .eq('is_active', true)
        .single();

      if (serviceError || !service) {
        throw AppError.notFound('Serviço não encontrado');
      }

      // Check if professional can perform this service
      if (!service.professional_ids.includes(input.professional_id)) {
        throw AppError.badRequest('Este profissional não realiza este serviço');
      }

      // Check availability
      const startsAt = new Date(input.starts_at);
      const endsAt = new Date(startsAt.getTime() + service.duration_minutes * 60000);
      const dateStr = formatDate(startsAt);
      const timeStr = formatTime(startsAt);
      const endTimeStr = formatTime(endsAt);

      const workingHours = getWorkingHoursForDate(professional.working_hours, startsAt);
      if (!workingHours || workingHours.is_closed) {
        throw AppError.badRequest('Profissional não atende neste dia');
      }

      const { data: tenant } = await supabase
        .from('tenants')
        .select('settings')
        .eq('id', request.user.tenant_id)
        .single();

      const slotDuration = tenant?.settings?.slot_duration_minutes || 30;

      // Get existing appointments for the day
      const startOfDay = new Date(startsAt);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(startsAt);
      endOfDay.setHours(23, 59, 59, 999);

      const { data: existingAppointments } = await supabase
        .from('appointments')
        .select('starts_at, ends_at')
        .eq('professional_id', input.professional_id)
        .eq('tenant_id', request.user.tenant_id)
        .gte('starts_at', startOfDay.toISOString())
        .lte('starts_at', endOfDay.toISOString())
        .in('status', ['pending', 'confirmed']);

      const isAvailable = isSlotAvailable(
        timeStr,
        endTimeStr,
        workingHours,
        existingAppointments || [],
        service.preparation_minutes
      );

      if (!isAvailable) {
        throw AppError.conflict('Horário não disponível');
      }

      // Get tenant info for WhatsApp
      const { data: tenantInfo } = await supabase
        .from('tenants')
        .select('name, address, settings')
        .eq('id', request.user.tenant_id)
        .single();

      // Create appointment
      const { data: appointment, error } = await supabase
        .from('appointments')
        .insert({
          ...input,
          tenant_id: request.user.tenant_id,
          ends_at: endsAt.toISOString(),
          price: service.price,
          status: tenantInfo?.settings?.require_confirmation ? 'pending' : 'confirmed',
        })
        .select(`
          *,
          client:clients(id, name, phone, whatsapp),
          professional:professionals(id, name),
          service:services(id, name, duration_minutes, price)
        `)
        .single();

      if (error) {
        throw AppError.internal('Erro ao criar agendamento');
      }

      // Update client stats
      await supabase.rpc('increment_client_stats', {
        client_id: input.client_id,
        amount: service.price,
      });

      // Send WhatsApp confirmation if enabled
      const shouldSendWhatsApp = tenantInfo?.settings?.whatsapp_enabled &&
        tenantInfo?.settings?.require_confirmation === false &&
        (client.whatsapp || client.phone);

      if (shouldSendWhatsApp) {
        try {
          const phone = client.whatsapp || client.phone!;
          const message = WHATSAPP_TEMPLATES.APPOINTMENT_CONFIRMED({
            clientName: client.name,
            serviceName: service.name,
            professionalName: professional.name,
            date: formatDate(appointment.starts_at),
            time: formatTime(appointment.starts_at),
            address: tenantInfo?.address || 'Endereço não informado',
            tenantName: tenantInfo?.name || 'Estabelecimento',
          });

          await sendTextMessage({ number: phone, text: message });

          // Update confirmation sent flag
          await supabase
            .from('appointments')
            .update({ confirmation_sent: true })
            .eq('id', appointment.id);

          // Log WhatsApp message
          await supabase.from('whatsapp_logs').insert({
            tenant_id: request.user.tenant_id,
            appointment_id: appointment.id,
            client_id: client.id,
            phone,
            message_type: 'text',
            content: message,
            status: 'sent',
          });
        } catch (whatsappError) {
          console.error('WhatsApp error:', whatsappError);
          // Log failed message
          await supabase.from('whatsapp_logs').insert({
            tenant_id: request.user.tenant_id,
            appointment_id: appointment.id,
            client_id: client.id,
            phone: client.whatsapp || client.phone!,
            message_type: 'text',
            content: 'Falha ao enviar confirmação',
            status: 'failed',
            error_message: String(whatsappError),
          });
        }
      }

      return reply.status(201).send({
        success: true,
        data: appointment,
        message: 'Agendamento criado com sucesso',
      });
    }
  );

  // Update appointment
  server.patch(
    '/:id',
    {
      preHandler: [authenticate],
      schema: {
        params: z.object({ id: uuidSchema }),
        body: updateAppointmentSchema,
      },
    },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params;
      const input = request.body;

      // Get current appointment
      const { data: current, error: currentError } = await supabase
        .from('appointments')
        .select('*')
        .eq('id', id)
        .eq('tenant_id', request.user.tenant_id)
        .single();

      if (currentError || !current) {
        throw AppError.notFound('Agendamento não encontrado');
      }

      // Check professional access
      if (request.user.role === 'professional' && request.user.professional_id !== current.professional_id) {
        throw AppError.forbidden('Acesso negado');
      }

      // If changing professional or time, validate availability
      if (input.professional_id || input.starts_at || input.service_id) {
        const professionalId = input.professional_id || current.professional_id;
        const serviceId = input.service_id || current.service_id;
        const startsAt = input.starts_at ? new Date(input.starts_at) : new Date(current.starts_at);

        const { data: professional } = await supabase
          .from('professionals')
          .select('working_hours')
          .eq('id', professionalId)
          .eq('tenant_id', request.user.tenant_id)
          .single();

        const { data: service } = await supabase
          .from('services')
          .select('duration_minutes, professional_ids, preparation_minutes')
          .eq('id', serviceId)
          .eq('tenant_id', request.user.tenant_id)
          .single();

        if (service && !service.professional_ids.includes(professionalId)) {
          throw AppError.badRequest('Profissional não realiza este serviço');
        }

        if (professional && service) {
          const endsAt = new Date(startsAt.getTime() + service.duration_minutes * 60000);
          const timeStr = formatTime(startsAt);
          const endTimeStr = formatTime(endsAt);

          const workingHours = getWorkingHoursForDate(professional.working_hours, startsAt);
          if (!workingHours || workingHours.is_closed) {
            throw AppError.badRequest('Profissional não atende neste dia');
          }

          const { data: tenant } = await supabase
            .from('tenants')
            .select('settings')
            .eq('id', request.user.tenant_id)
            .single();

          const slotDuration = tenant?.settings?.slot_duration_minutes || 30;

          const startOfDay = new Date(startsAt);
          startOfDay.setHours(0, 0, 0, 0);
          const endOfDay = new Date(startsAt);
          endOfDay.setHours(23, 59, 59, 999);

          const { data: existingAppointments } = await supabase
            .from('appointments')
            .select('starts_at, ends_at')
            .eq('professional_id', professionalId)
            .eq('tenant_id', request.user.tenant_id)
            .gte('starts_at', startOfDay.toISOString())
            .lte('starts_at', endOfDay.toISOString())
            .in('status', ['pending', 'confirmed'])
            .neq('id', id);

          const isAvailable = isSlotAvailable(
            timeStr,
            endTimeStr,
            workingHours,
            existingAppointments || [],
            service.preparation_minutes
          );

          if (!isAvailable) {
            throw AppError.conflict('Horário não disponível');
          }

          input.ends_at = endsAt.toISOString();
        }
      }

      const { data: appointment, error } = await supabase
        .from('appointments')
        .update(input)
        .eq('id', id)
        .eq('tenant_id', request.user.tenant_id)
        .select(`
          *,
          client:clients(id, name, phone, whatsapp),
          professional:professionals(id, name),
          service:services(id, name, duration_minutes, price)
        `)
        .single();

      if (error) {
        throw AppError.internal('Erro ao atualizar agendamento');
      }

      // Send WhatsApp notification for status changes
      if (input.status && input.status !== current.status) {
        const { data: tenantInfo } = await supabase
          .from('tenants')
          .select('name, address, settings')
          .eq('id', request.user.tenant_id)
          .single();

        const { data: client } = await supabase
          .from('clients')
          .select('name, phone, whatsapp')
          .eq('id', appointment.client_id)
          .single();

        if (tenantInfo?.settings?.whatsapp_enabled && client) {
          try {
            const phone = client.whatsapp || client.phone;
            let message = '';

            switch (input.status) {
              case 'confirmed':
                message = WHATSAPP_TEMPLATES.APPOINTMENT_CONFIRMED({
                  clientName: client.name,
                  serviceName: appointment.service.name,
                  professionalName: appointment.professional.name,
                  date: formatDate(appointment.starts_at),
                  time: formatTime(appointment.starts_at),
                  address: tenantInfo.address || 'Endereço não informado',
                  tenantName: tenantInfo.name,
                });
                break;
              case 'cancelled':
                message = WHATSAPP_TEMPLATES.APPOINTMENT_CANCELLED({
                  clientName: client.name,
                  serviceName: appointment.service.name,
                  date: formatDate(appointment.starts_at),
                  time: formatTime(appointment.starts_at),
                  tenantName: tenantInfo.name,
                });
                break;
              case 'rescheduled':
                message = WHATSAPP_TEMPLATES.APPOINTMENT_RESCHEDULED({
                  clientName: client.name,
                  serviceName: appointment.service.name,
                  professionalName: appointment.professional.name,
                  oldDate: formatDate(current.starts_at),
                  oldTime: formatTime(current.starts_at),
                  newDate: formatDate(appointment.starts_at),
                  newTime: formatTime(appointment.starts_at),
                  tenantName: tenantInfo.name,
                });
                break;
            }

            if (message) {
              await sendTextMessage({ number: phone, text: message });
              await supabase.from('whatsapp_logs').insert({
                tenant_id: request.user.tenant_id,
                appointment_id: appointment.id,
                client_id: client.id,
                phone,
                message_type: 'text',
                content: message,
                status: 'sent',
              });
            }
          } catch (whatsappError) {
            console.error('WhatsApp error:', whatsappError);
          }
        }
      }

      return {
        success: true,
        data: appointment,
        message: 'Agendamento atualizado com sucesso',
      };
    }
  );

  // Reschedule appointment
  server.post(
    '/:id/reschedule',
    {
      preHandler: [authenticate],
      schema: {
        params: z.object({ id: uuidSchema }),
        body: rescheduleAppointmentSchema,
      },
    },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params;
      const { new_starts_at, professional_id } = request.body;

      const { data: current, error: currentError } = await supabase
        .from('appointments')
        .select('*')
        .eq('id', id)
        .eq('tenant_id', request.user.tenant_id)
        .single();

      if (currentError || !current) {
        throw AppError.notFound('Agendamento não encontrado');
      }

      // Check professional access
      if (request.user.role === 'professional' && request.user.professional_id !== current.professional_id) {
        throw AppError.forbidden('Acesso negado');
      }

      const targetProfessionalId = professional_id || current.professional_id;
      const newStartsAt = new Date(new_starts_at);

      const { data: professional } = await supabase
        .from('professionals')
        .select('working_hours, name')
        .eq('id', targetProfessionalId)
        .eq('tenant_id', request.user.tenant_id)
        .single();

      const { data: service } = await supabase
        .from('services')
        .select('duration_minutes, professional_ids, preparation_minutes, name')
        .eq('id', current.service_id)
        .eq('tenant_id', request.user.tenant_id)
        .single();

      if (!professional || !service) {
        throw AppError.notFound('Profissional ou serviço não encontrado');
      }

      if (!service.professional_ids.includes(targetProfessionalId)) {
        throw AppError.badRequest('Profissional não realiza este serviço');
      }

      const newEndsAt = new Date(newStartsAt.getTime() + service.duration_minutes * 60000);
      const timeStr = formatTime(newStartsAt);
      const endTimeStr = formatTime(newEndsAt);

      const workingHours = getWorkingHoursForDate(professional.working_hours, newStartsAt);
      if (!workingHours || workingHours.is_closed) {
        throw AppError.badRequest('Profissional não atende neste dia');
      }

      const { data: tenant } = await supabase
        .from('tenants')
        .select('settings')
        .eq('id', request.user.tenant_id)
        .single();

      const slotDuration = tenant?.settings?.slot_duration_minutes || 30;

      const startOfDay = new Date(newStartsAt);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(newStartsAt);
      endOfDay.setHours(23, 59, 59, 999);

      const { data: existingAppointments } = await supabase
        .from('appointments')
        .select('starts_at, ends_at')
        .eq('professional_id', targetProfessionalId)
        .eq('tenant_id', request.user.tenant_id)
        .gte('starts_at', startOfDay.toISOString())
        .lte('starts_at', endOfDay.toISOString())
        .in('status', ['pending', 'confirmed'])
        .neq('id', id);

      const isAvailable = isSlotAvailable(
        timeStr,
        endTimeStr,
        workingHours,
        existingAppointments || [],
        service.preparation_minutes
      );

      if (!isAvailable) {
        throw AppError.conflict('Horário não disponível');
      }

      const { data: appointment, error } = await supabase
        .from('appointments')
        .update({
          professional_id: targetProfessionalId,
          starts_at: newStartsAt.toISOString(),
          ends_at: newEndsAt.toISOString(),
          status: 'rescheduled',
        })
        .eq('id', id)
        .eq('tenant_id', request.user.tenant_id)
        .select(`
          *,
          client:clients(id, name, phone, whatsapp),
          professional:professionals(id, name),
          service:services(id, name, duration_minutes, price)
        `)
        .single();

      if (error) {
        throw AppError.internal('Erro ao reagendar agendamento');
      }

      return {
        success: true,
        data: appointment,
        message: 'Agendamento reagendado com sucesso',
      };
    }
  );

  // Cancel appointment
  server.post(
    '/:id/cancel',
    {
      preHandler: [authenticate],
      schema: {
        params: z.object({ id: uuidSchema }),
        body: z.object({
          reason: z.string().max(500).optional(),
        }),
      },
    },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params;
      const { reason } = request.body;

      const { data: current, error: currentError } = await supabase
        .from('appointments')
        .select('*')
        .eq('id', id)
        .eq('tenant_id', request.user.tenant_id)
        .single();

      if (currentError || !current) {
        throw AppError.notFound('Agendamento não encontrado');
      }

      // Check professional access
      if (request.user.role === 'professional' && request.user.professional_id !== current.professional_id) {
        throw AppError.forbidden('Acesso negado');
      }

      // Check cancellation policy
      const { data: tenant } = await supabase
        .from('tenants')
        .select('settings')
        .eq('id', request.user.tenant_id)
        .single();

      const cancellationHours = tenant?.settings?.cancellation_hours || 2;
      const hoursUntilAppointment = (new Date(current.starts_at).getTime() - Date.now()) / (1000 * 60 * 60);

      if (hoursUntilAppointment < cancellationHours && request.user.role !== 'owner' && request.user.role !== 'admin') {
        throw AppError.badRequest(`Cancelamento só permitido com ${cancellationHours}h de antecedência`);
      }

      const { data: appointment, error } = await supabase
        .from('appointments')
        .update({
          status: 'cancelled',
          cancellation_reason: reason,
          cancelled_by: request.user.id,
          cancelled_at: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('tenant_id', request.user.tenant_id)
        .select(`
          *,
          client:clients(id, name, phone, whatsapp),
          professional:professionals(id, name),
          service:services(id, name, duration_minutes, price)
        `)
        .single();

      if (error) {
        throw AppError.internal('Erro ao cancelar agendamento');
      }

      return {
        success: true,
        data: appointment,
        message: 'Agendamento cancelado com sucesso',
      };
    }
  );

  // Check availability for a specific date
  server.get(
    '/availability',
    {
      preHandler: [authenticate],
      schema: {
        querystring: availabilityQuerySchema,
      },
    },
    async (request: AuthenticatedRequest, reply) => {
      const { professional_id, service_id, date } = request.query;

      // Get service
      const { data: service, error: serviceError } = await supabase
        .from('services')
        .select('duration_minutes, professional_ids, preparation_minutes')
        .eq('id', service_id)
        .eq('tenant_id', request.user.tenant_id)
        .eq('is_active', true)
        .single();

      if (serviceError || !service) {
        throw AppError.notFound('Serviço não encontrado');
      }

      // Get professionals who can perform this service
      let professionalQuery = supabase
        .from('professionals')
        .select('id, name, working_hours, avatar_url')
        .eq('tenant_id', request.user.tenant_id)
        .eq('is_active', true)
        .contains('professional_ids', [service_id]);

      if (professional_id) {
        professionalQuery = professionalQuery.eq('id', professional_id);
      }

      const { data: professionals } = await professionalQuery;

      if (!professionals || professionals.length === 0) {
        return {
          success: true,
          data: { date, professionals: [] },
        };
      }

      // Get tenant settings
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
        .select('professional_id, starts_at, ends_at')
        .eq('tenant_id', request.user.tenant_id)
        .gte('starts_at', startOfDay.toISOString())
        .lte('starts_at', endOfDay.toISOString())
        .in('status', ['pending', 'confirmed']);

      // Generate availability for each professional
      const availability = professionals.map(prof => {
        const profAppointments = (appointments || []).filter(a => a.professional_id === prof.id);
        const dayOfWeek = new Date(date).getDay();
        const workingHours = prof.working_hours.find((wh: WorkingHours) => wh.day_of_week === dayOfWeek);

        if (!workingHours || workingHours.is_closed) {
          return {
            professional_id: prof.id,
            professional_name: prof.name,
            professional_avatar: prof.avatar_url,
            is_closed: true,
            slots: [],
          };
        }

        const slots = generateTimeSlots(
          workingHours,
          slotDuration,
          profAppointments,
          service.preparation_minutes
        );

        return {
          professional_id: prof.id,
          professional_name: prof.name,
          professional_avatar: prof.avatar_url,
          is_closed: false,
          slots,
        };
      });

      return {
        success: true,
        data: { date, professionals: availability },
      };
    }
  );

  // Bulk availability for a date range
  server.post(
    '/availability/bulk',
    {
      preHandler: [authenticate],
      schema: {
        body: bulkAvailabilitySchema,
      },
    },
    async (request: AuthenticatedRequest, reply) => {
      const { professional_id, service_id, start_date, end_date } = request.body;

      // Get service
      const { data: service } = await supabase
        .from('services')
        .select('duration_minutes, professional_ids, preparation_minutes')
        .eq('id', service_id)
        .eq('tenant_id', request.user.tenant_id)
        .single();

      if (!service) {
        throw AppError.notFound('Serviço não encontrado');
      }

      // Get professionals
      let professionalQuery = supabase
        .from('professionals')
        .select('id, name, working_hours')
        .eq('tenant_id', request.user.tenant_id)
        .eq('is_active', true)
        .contains('professional_ids', [service_id]);

      if (professional_id) {
        professionalQuery = professionalQuery.eq('id', professional_id);
      }

      const { data: professionals } = await professionalQuery;

      if (!professionals || professionals.length === 0) {
        return { success: true, data: { availability: [] } };
      }

      // Get tenant settings
      const { data: tenant } = await supabase
        .from('tenants')
        .select('settings')
        .eq('id', request.user.tenant_id)
        .single();

      const slotDuration = tenant?.settings?.slot_duration_minutes || 30;

      // Get all appointments in range
      const { data: appointments } = await supabase
        .from('appointments')
        .select('professional_id, starts_at, ends_at')
        .eq('tenant_id', request.user.tenant_id)
        .gte('starts_at', start_date)
        .lte('starts_at', end_date)
        .in('status', ['pending', 'confirmed']);

      // Generate availability for each day
      const startDate = new Date(start_date);
      const endDate = new Date(end_date);
      const availability: Array<{
        date: string;
        professionals: Array<{
          professional_id: string;
          professional_name: string;
          is_closed: boolean;
          slots: Array<{ start: string; end: string; available: boolean }>;
        }>;
      }> = [];

      for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
        const dateStr = formatDate(d);
        const dayOfWeek = d.getDay();

        const dayAvailability = professionals.map(prof => {
          const profAppointments = (appointments || []).filter(a => a.professional_id === prof.id);
          const workingHours = prof.working_hours.find((wh: WorkingHours) => wh.day_of_week === dayOfWeek);

          if (!workingHours || workingHours.is_closed) {
            return {
              professional_id: prof.id,
              professional_name: prof.name,
              is_closed: true,
              slots: [],
            };
          }

          const slots = generateTimeSlots(
            workingHours,
            slotDuration,
            profAppointments,
            service.preparation_minutes
          );

          return {
            professional_id: prof.id,
            professional_name: prof.name,
            is_closed: false,
            slots,
          };
        });

        availability.push({ date: dateStr, professionals: dayAvailability });
      }

      return {
        success: true,
        data: { availability },
      };
    }
  );

  // Get today's appointments (dashboard)
  server.get(
    '/dashboard/today',
    {
      preHandler: [authenticate],
    },
    async (request: AuthenticatedRequest, reply) => {
      const today = new Date();
      const startOfDay = new Date(today);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(today);
      endOfDay.setHours(23, 59, 59, 999);

      let query = supabase
        .from('appointments')
        .select(`
          *,
          client:clients(id, name, phone, whatsapp),
          professional:professionals(id, name, avatar_url),
          service:services(id, name, duration_minutes, price, color)
        `)
        .eq('tenant_id', request.user.tenant_id)
        .gte('starts_at', startOfDay.toISOString())
        .lte('starts_at', endOfDay.toISOString())
        .order('starts_at', { ascending: true });

      if (request.user.role === 'professional' && request.user.professional_id) {
        query = query.eq('professional_id', request.user.professional_id);
      }

      const { data: appointments } = await query;

      // Group by status
      const byStatus = (appointments || []).reduce((acc, appt) => {
        if (!acc[appt.status]) acc[appt.status] = [];
        acc[appt.status].push(appt);
        return acc;
      }, {} as Record<AppointmentStatus, typeof appointments>);

      // Stats
      const stats = {
        total: appointments?.length || 0,
        pending: byStatus.pending?.length || 0,
        confirmed: byStatus.confirmed?.length || 0,
        completed: byStatus.completed?.length || 0,
        cancelled: byStatus.cancelled?.length || 0,
        no_show: byStatus.no_show?.length || 0,
        revenue: (appointments || [])
          .filter(a => ['confirmed', 'completed'].includes(a.status))
          .reduce((sum, a) => sum + (a.price || 0), 0),
      };

      return {
        success: true,
        data: {
          appointments: appointments || [],
          by_status: byStatus,
          stats,
        },
      };
    }
  );

  // Get appointment stats for period
  server.get(
    '/stats/period',
    {
      preHandler: [authenticate, requireRole('owner', 'admin', 'receptionist')],
      schema: {
        querystring: z.object({
          start_date: z.string().date(),
          end_date: z.string().date(),
          group_by: z.enum(['day', 'week', 'month', 'professional', 'service']).default('day'),
        }),
      },
    },
    async (request: AuthenticatedRequest, reply) => {
      const { start_date, end_date, group_by } = request.query;

      const { data: appointments } = await supabase
        .from('appointments')
        .select('status, starts_at, price, professional_id, service_id')
        .eq('tenant_id', request.user.tenant_id)
        .gte('starts_at', start_date)
        .lte('starts_at', end_date);

      if (!appointments) {
        return { success: true, data: { stats: [], summary: {} } };
      }

      const completedAppointments = appointments.filter(a => a.status === 'completed');
      const confirmedAppointments = appointments.filter(a => a.status === 'confirmed');
      const cancelledAppointments = appointments.filter(a => a.status === 'cancelled');
      const noShowAppointments = appointments.filter(a => a.status === 'no_show');

      const totalRevenue = completedAppointments.reduce((sum, a) => sum + (a.price || 0), 0);

      return {
        success: true,
        data: {
          summary: {
            total: appointments.length,
            completed: completedAppointments.length,
            confirmed: confirmedAppointments.length,
            cancelled: cancelledAppointments.length,
            no_show: noShowAppointments.length,
            revenue: totalRevenue,
            conversion_rate: appointments.length > 0
              ? (completedAppointments.length / appointments.length) * 100
              : 0,
          },
        },
      };
    }
  );
}

// Helper function (duplicate from date.ts for self-contained routes)
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

    const isBreak = workingHours.breaks?.some(breakTime => {
      const [breakStartHour, breakStartMinute] = breakTime.start.split(':').map(Number);
      const [breakEndHour, breakEndMinute] = breakTime.end.split(':').map(Number);
      const breakStartMinutes = breakStartHour * 60 + breakStartMinute;
      const breakEndMinutes = breakEndHour * 60 + breakEndMinute;
      return slotStart >= breakStartMinutes && slotEnd <= breakEndMinutes;
    }) ?? false;

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