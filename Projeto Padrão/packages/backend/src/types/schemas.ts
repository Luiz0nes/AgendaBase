import { z } from 'zod';
import type { TenantType, MemberRole, AppointmentStatus } from './database';

// Common schemas
export const uuidSchema = z.string().uuid();
export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export const dateRangeSchema = z.object({
  start: z.string().datetime().optional(),
  end: z.string().datetime().optional(),
});

// Tenant schemas
export const createTenantSchema = z.object({
  name: z.string().min(2).max(100),
  slug: z.string().min(3).max(50).regex(/^[a-z0-9-]+$/),
  type: z.enum(['barbearia', 'clinica', 'dentista', 'outro']),
  primary_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#1a1a2e'),
  secondary_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#16213e'),
  address: z.string().max(200).optional(),
  phone: z.string().max(20).optional(),
  email: z.string().email().optional(),
  description: z.string().max(500).optional(),
});

export const updateTenantSchema = createTenantSchema.partial();

export const tenantSettingsSchema = z.object({
  working_hours: z.array(z.object({
    day_of_week: z.number().int().min(0).max(6),
    open_time: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
    close_time: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
    is_closed: z.boolean().default(false),
    breaks: z.array(z.object({
      start: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
      end: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
    })).optional(),
  })).length(7),
  slot_duration_minutes: z.number().int().min(15).max(120).default(30),
  advance_booking_days: z.number().int().min(1).max(365).default(60),
  cancellation_hours: z.number().int().min(0).max(168).default(2),
  reminder_hours_before: z.array(z.number().int().positive()).default([24, 2]),
  whatsapp_enabled: z.boolean().default(true),
  whatsapp_template_confirmed: z.string().optional(),
  whatsapp_template_reminder: z.string().optional(),
  whatsapp_template_cancelled: z.string().optional(),
  allow_online_booking: z.boolean().default(true),
  require_confirmation: z.boolean().default(false),
  custom_fields: z.array(z.object({
    id: z.string(),
    label: z.string(),
    type: z.enum(['text', 'select', 'boolean', 'date']),
    required: z.boolean(),
    options: z.array(z.string()).optional(),
    placeholder: z.string().optional(),
  })).default([]),
});

// Member schemas
export const inviteMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'professional', 'receptionist']),
  professional_id: z.string().uuid().optional(),
});

export const updateMemberSchema = z.object({
  role: z.enum(['admin', 'professional', 'receptionist']).optional(),
  professional_id: z.string().uuid().nullable().optional(),
});

// Professional schemas
export const createProfessionalSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email().optional().nullable(),
  phone: z.string().max(20).optional().nullable(),
  bio: z.string().max(500).optional().nullable(),
  specialties: z.array(z.string()).default([]),
  working_hours: z.array(z.object({
    day_of_week: z.number().int().min(0).max(6),
    open_time: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
    close_time: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
    is_closed: z.boolean().default(false),
    breaks: z.array(z.object({
      start: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
      end: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
    })).optional(),
  })).length(7),
  commission_percentage: z.number().min(0).max(100).optional().nullable(),
});

export const updateProfessionalSchema = createProfessionalSchema.partial();

// Service schemas
export const createServiceSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().max(500).optional().nullable(),
  duration_minutes: z.number().int().min(15).max(480),
  price: z.number().min(0),
  category: z.string().max(50).optional().nullable(),
  professional_ids: z.array(z.string().uuid()).default([]),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().nullable(),
  requires_preparation: z.boolean().default(false),
  preparation_minutes: z.number().int().min(0).max(60).default(0),
});

export const updateServiceSchema = createServiceSchema.partial();

// Client schemas
export const createClientSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email().optional().nullable(),
  phone: z.string().min(10).max(20),
  whatsapp: z.string().max(20).optional().nullable(),
  birth_date: z.string().date().optional().nullable(),
  gender: z.enum(['male', 'female', 'other']).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
  custom_data: z.record(z.unknown()).default({}),
  tags: z.array(z.string()).default([]),
});

export const updateClientSchema = createClientSchema.partial();

// Appointment schemas
export const createAppointmentSchema = z.object({
  client_id: z.string().uuid(),
  professional_id: z.string().uuid(),
  service_id: z.string().uuid(),
  starts_at: z.string().datetime(),
  notes: z.string().max(1000).optional().nullable(),
  custom_data: z.record(z.unknown()).default({}),
});

export const updateAppointmentSchema = z.object({
  professional_id: z.string().uuid().optional(),
  service_id: z.string().uuid().optional(),
  starts_at: z.string().datetime().optional(),
  status: z.enum(['pending', 'confirmed', 'cancelled', 'completed', 'no_show', 'rescheduled']).optional(),
  notes: z.string().max(1000).optional().nullable(),
  cancellation_reason: z.string().max(500).optional().nullable(),
  custom_data: z.record(z.unknown()).optional(),
});

export const rescheduleAppointmentSchema = z.object({
  new_starts_at: z.string().datetime(),
  professional_id: z.string().uuid().optional(),
});

// Availability schemas
export const availabilityQuerySchema = z.object({
  professional_id: z.string().uuid().optional(),
  service_id: z.string().uuid(),
  date: z.string().date(),
});

export const bulkAvailabilitySchema = z.object({
  professional_id: z.string().uuid().optional(),
  service_id: z.string().uuid(),
  start_date: z.string().date(),
  end_date: z.string().date(),
});

// Webhook schemas
export const evolutionWebhookSchema = z.object({
  event: z.enum(['messages.upsert', 'messages.update', 'connection.update']),
  instance: z.string(),
  data: z.any(),
});

// Auth schemas
export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export const registerSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email(),
  password: z.string().min(8),
  tenant_slug: z.string().min(3).max(50).regex(/^[a-z0-9-]+$/),
  tenant_name: z.string().min(2).max(100),
  tenant_type: z.enum(['barbearia', 'clinica', 'dentista', 'outro']),
});

export const resetPasswordSchema = z.object({
  email: z.string().email(),
});

export const updatePasswordSchema = z.object({
  current_password: z.string().min(8),
  new_password: z.string().min(8),
});

// Type exports
export type CreateTenantInput = z.infer<typeof createTenantSchema>;
export type UpdateTenantInput = z.infer<typeof updateTenantSchema>;
export type TenantSettingsInput = z.infer<typeof tenantSettingsSchema>;
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;
export type CreateProfessionalInput = z.infer<typeof createProfessionalSchema>;
export type UpdateProfessionalInput = z.infer<typeof updateProfessionalSchema>;
export type CreateServiceInput = z.infer<typeof createServiceSchema>;
export type UpdateServiceInput = z.infer<typeof updateServiceSchema>;
export type CreateClientInput = z.infer<typeof createClientSchema>;
export type UpdateClientInput = z.infer<typeof updateClientSchema>;
export type CreateAppointmentInput = z.infer<typeof createAppointmentSchema>;
export type UpdateAppointmentInput = z.infer<typeof updateAppointmentSchema>;
export type RescheduleAppointmentInput = z.infer<typeof rescheduleAppointmentSchema>;
export type AvailabilityQueryInput = z.infer<typeof availabilityQuerySchema>;
export type BulkAvailabilityInput = z.infer<typeof bulkAvailabilitySchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type UpdatePasswordInput = z.infer<typeof updatePasswordSchema>;