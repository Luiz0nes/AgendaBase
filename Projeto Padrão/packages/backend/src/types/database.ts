// Database types matching Supabase schema
// Run `npm run db:generate` in backend to update these types

export type TenantType = 'barbearia' | 'clinica' | 'dentista' | 'outro';

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  type: TenantType;
  logo_url: string | null;
  primary_color: string;
  secondary_color: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  description: string | null;
  settings: TenantSettings;
  created_at: string;
  updated_at: string;
}

export interface TenantSettings {
  working_hours: WorkingHours[];
  slot_duration_minutes: number;
  advance_booking_days: number;
  cancellation_hours: number;
  reminder_hours_before: number[];
  whatsapp_enabled: boolean;
  whatsapp_template_confirmed: string | null;
  whatsapp_template_reminder: string | null;
  whatsapp_template_cancelled: string | null;
  allow_online_booking: boolean;
  require_confirmation: boolean;
  custom_fields: CustomField[];
}

export interface WorkingHours {
  day_of_week: number; // 0 = Sunday, 6 = Saturday
  open_time: string; // HH:mm
  close_time: string; // HH:mm
  is_closed: boolean;
  breaks?: TimeSlot[];
}

export interface TimeSlot {
  start: string; // HH:mm
  end: string; // HH:mm
}

export interface CustomField {
  id: string;
  label: string;
  type: 'text' | 'select' | 'boolean' | 'date';
  required: boolean;
  options?: string[];
  placeholder?: string;
}

export interface TenantMember {
  id: string;
  tenant_id: string;
  user_id: string;
  role: MemberRole;
  professional_id: string | null;
  created_at: string;
}

export type MemberRole = 'owner' | 'admin' | 'professional' | 'receptionist';

export interface Professional {
  id: string;
  tenant_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  avatar_url: string | null;
  bio: string | null;
  specialties: string[];
  working_hours: WorkingHours[];
  is_active: boolean;
  commission_percentage: number | null;
  created_at: string;
  updated_at: string;
}

export interface Service {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  duration_minutes: number;
  price: number;
  category: string | null;
  professional_ids: string[]; // Which professionals can perform this service
  color: string | null; // For calendar display
  is_active: boolean;
  requires_preparation: boolean;
  preparation_minutes: number;
  created_at: string;
  updated_at: string;
}

export interface Client {
  id: string;
  tenant_id: string;
  name: string;
  email: string | null;
  phone: string;
  whatsapp: string | null;
  birth_date: string | null;
  gender: 'male' | 'female' | 'other' | null;
  notes: string | null;
  custom_data: Record<string, unknown>;
  tags: string[];
  total_appointments: number;
  total_spent: number;
  last_appointment_at: string | null;
  created_at: string;
  updated_at: string;
}

export type AppointmentStatus =
  | 'pending'
  | 'confirmed'
  | 'cancelled'
  | 'completed'
  | 'no_show'
  | 'rescheduled';

export interface Appointment {
  id: string;
  tenant_id: string;
  client_id: string;
  professional_id: string;
  service_id: string;
  status: AppointmentStatus;
  starts_at: string;
  ends_at: string;
  price: number;
  notes: string | null;
  cancellation_reason: string | null;
  cancelled_by: string | null;
  cancelled_at: string | null;
  reminder_sent: boolean;
  confirmation_sent: boolean;
  created_at: string;
  updated_at: string;
}

export interface AppointmentWithRelations extends Appointment {
  client: Client;
  professional: Professional;
  service: Service;
}

// WhatsApp message log
export interface WhatsAppLog {
  id: string;
  tenant_id: string;
  appointment_id: string | null;
  client_id: string | null;
  phone: string;
  message_type: 'text' | 'template';
  template_name: string | null;
  content: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  evolution_message_id: string | null;
  error_message: string | null;
  sent_at: string;
  delivered_at: string | null;
  read_at: string | null;
}

// Audit log
export interface AuditLog {
  id: string;
  tenant_id: string;
  user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  old_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

// Subscription/Plan
export type PlanType = 'free' | 'starter' | 'professional' | 'enterprise';

export interface TenantSubscription {
  id: string;
  tenant_id: string;
  plan: PlanType;
  status: 'active' | 'past_due' | 'cancelled' | 'trialing';
  current_period_start: string;
  current_period_end: string;
  cancel_at_period_end: boolean;
  trial_end: string | null;
  created_at: string;
  updated_at: string;
}