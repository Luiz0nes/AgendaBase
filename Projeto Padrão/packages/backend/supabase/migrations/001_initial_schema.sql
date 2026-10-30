-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Custom types
CREATE TYPE tenant_type AS ENUM ('barbearia', 'clinica', 'dentista', 'outro');
CREATE TYPE member_role AS ENUM ('owner', 'admin', 'professional', 'receptionist');
CREATE TYPE appointment_status AS ENUM ('pending', 'confirmed', 'cancelled', 'completed', 'no_show', 'rescheduled');
CREATE TYPE plan_type AS ENUM ('free', 'starter', 'professional', 'enterprise');
CREATE TYPE subscription_status AS ENUM ('active', 'past_due', 'cancelled', 'trialing');

-- Tenants table
CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(50) UNIQUE NOT NULL,
  type tenant_type NOT NULL DEFAULT 'outro',
  logo_url TEXT,
  primary_color VARCHAR(7) NOT NULL DEFAULT '#1a1a2e',
  secondary_color VARCHAR(7) NOT NULL DEFAULT '#16213e',
  address TEXT,
  phone VARCHAR(20),
  email VARCHAR(255),
  description TEXT,
  settings JSONB NOT NULL DEFAULT '{
    "working_hours": [
      {"day_of_week": 0, "open_time": "09:00", "close_time": "18:00", "is_closed": true},
      {"day_of_week": 1, "open_time": "09:00", "close_time": "18:00", "is_closed": false},
      {"day_of_week": 2, "open_time": "09:00", "close_time": "18:00", "is_closed": false},
      {"day_of_week": 3, "open_time": "09:00", "close_time": "18:00", "is_closed": false},
      {"day_of_week": 4, "open_time": "09:00", "close_time": "18:00", "is_closed": false},
      {"day_of_week": 5, "open_time": "09:00", "close_time": "18:00", "is_closed": false},
      {"day_of_week": 6, "open_time": "09:00", "close_time": "14:00", "is_closed": false}
    ],
    "slot_duration_minutes": 30,
    "advance_booking_days": 60,
    "cancellation_hours": 2,
    "reminder_hours_before": [24, 2],
    "whatsapp_enabled": true,
    "whatsapp_template_confirmed": null,
    "whatsapp_template_reminder": null,
    "whatsapp_template_cancelled": null,
    "allow_online_booking": true,
    "require_confirmation": false,
    "custom_fields": []
  }',
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tenant members (users with roles in a tenant)
CREATE TABLE tenant_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL, -- References auth.users
  role member_role NOT NULL DEFAULT 'receptionist',
  professional_id UUID, -- References professionals(id), nullable
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, user_id)
);

-- Professionals
CREATE TABLE professionals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(255),
  phone VARCHAR(20),
  avatar_url TEXT,
  bio TEXT,
  specialties TEXT[] DEFAULT '{}',
  working_hours JSONB NOT NULL DEFAULT '[]',
  is_active BOOLEAN NOT NULL DEFAULT true,
  commission_percentage DECIMAL(5,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Services
CREATE TABLE services (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  price DECIMAL(10,2) NOT NULL CHECK (price >= 0),
  category VARCHAR(50),
  professional_ids UUID[] DEFAULT '{}',
  color VARCHAR(7),
  is_active BOOLEAN NOT NULL DEFAULT true,
  requires_preparation BOOLEAN NOT NULL DEFAULT false,
  preparation_minutes INTEGER NOT NULL DEFAULT 0 CHECK (preparation_minutes >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Clients
CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(255),
  phone VARCHAR(20) NOT NULL,
  whatsapp VARCHAR(20),
  birth_date DATE,
  gender VARCHAR(10) CHECK (gender IN ('male', 'female', 'other')),
  notes TEXT,
  custom_data JSONB DEFAULT '{}',
  tags TEXT[] DEFAULT '{}',
  total_appointments INTEGER NOT NULL DEFAULT 0,
  total_spent DECIMAL(10,2) NOT NULL DEFAULT 0,
  last_appointment_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Appointments
CREATE TABLE appointments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  professional_id UUID NOT NULL REFERENCES professionals(id) ON DELETE RESTRICT,
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  status appointment_status NOT NULL DEFAULT 'pending',
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  price DECIMAL(10,2) NOT NULL CHECK (price >= 0),
  notes TEXT,
  cancellation_reason TEXT,
  cancelled_by UUID, -- References auth.users
  cancelled_at TIMESTAMPTZ,
  reminder_sent BOOLEAN NOT NULL DEFAULT false,
  confirmation_sent BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- WhatsApp message logs
CREATE TABLE whatsapp_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  appointment_id UUID REFERENCES appointments(id) ON DELETE SET NULL,
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  phone VARCHAR(20) NOT NULL,
  message_type VARCHAR(20) NOT NULL CHECK (message_type IN ('text', 'template')),
  template_name VARCHAR(100),
  content TEXT NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('sent', 'delivered', 'read', 'failed', 'received')),
  evolution_message_id VARCHAR(100),
  error_message TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ
);

-- Audit logs
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID, -- References auth.users
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id UUID NOT NULL,
  old_data JSONB,
  new_data JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tenant subscriptions
CREATE TABLE tenant_subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE UNIQUE,
  plan plan_type NOT NULL DEFAULT 'free',
  status subscription_status NOT NULL DEFAULT 'active',
  current_period_start TIMESTAMPTZ NOT NULL,
  current_period_end TIMESTAMPTZ NOT NULL,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  trial_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_tenant_members_tenant_id ON tenant_members(tenant_id);
CREATE INDEX idx_tenant_members_user_id ON tenant_members(user_id);
CREATE INDEX idx_professionals_tenant_id ON professionals(tenant_id);
CREATE INDEX idx_professionals_is_active ON professionals(tenant_id, is_active);
CREATE INDEX idx_services_tenant_id ON services(tenant_id);
CREATE INDEX idx_services_is_active ON services(tenant_id, is_active);
CREATE INDEX idx_clients_tenant_id ON clients(tenant_id);
CREATE INDEX idx_clients_phone ON clients(tenant_id, phone);
CREATE INDEX idx_clients_whatsapp ON clients(tenant_id, whatsapp);
CREATE INDEX idx_appointments_tenant_id ON appointments(tenant_id);
CREATE INDEX idx_appointments_starts_at ON appointments(tenant_id, starts_at);
CREATE INDEX idx_appointments_status ON appointments(tenant_id, status);
CREATE INDEX idx_appointments_professional_id ON appointments(professional_id, starts_at);
CREATE INDEX idx_appointments_client_id ON appointments(client_id, starts_at);
CREATE INDEX idx_whatsapp_logs_tenant_id ON whatsapp_logs(tenant_id);
CREATE INDEX idx_whatsapp_logs_appointment_id ON whatsapp_logs(appointment_id);
CREATE INDEX idx_audit_logs_tenant_id ON audit_logs(tenant_id);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);

-- Row Level Security (RLS)
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE professionals ENABLE ROW LEVEL SECURITY;
ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_subscriptions ENABLE ROW LEVEL SECURITY;

-- RLS Policies

-- Tenants: users can only see their own tenant
CREATE POLICY "tenant_members_select" ON tenants
  FOR SELECT USING (
    id IN (
      SELECT tenant_id FROM tenant_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "tenant_members_insert" ON tenants
  FOR INSERT WITH CHECK (true); -- Allow registration

CREATE POLICY "tenant_members_update" ON tenants
  FOR UPDATE USING (
    id IN (
      SELECT tenant_id FROM tenant_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  );

-- Tenant members
CREATE POLICY "tm_select_own" ON tenant_members
  FOR SELECT USING (
    tenant_id IN (
      SELECT tenant_id FROM tenant_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "tm_insert_owner_admin" ON tenant_members
  FOR INSERT WITH CHECK (
    tenant_id IN (
      SELECT tenant_id FROM tenant_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  );

CREATE POLICY "tm_update_owner_admin" ON tenant_members
  FOR UPDATE USING (
    tenant_id IN (
      SELECT tenant_id FROM tenant_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  );

CREATE POLICY "tm_delete_owner_admin" ON tenant_members
  FOR DELETE USING (
    tenant_id IN (
      SELECT tenant_id FROM tenant_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  );

-- Professionals
CREATE POLICY "prof_select" ON professionals
  FOR SELECT USING (
    tenant_id IN (
      SELECT tenant_id FROM tenant_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "prof_insert_admin" ON professionals
  FOR INSERT WITH CHECK (
    tenant_id IN (
      SELECT tenant_id FROM tenant_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  );

CREATE POLICY "prof_update_admin" ON professionals
  FOR UPDATE USING (
    tenant_id IN (
      SELECT tenant_id FROM tenant_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  );

CREATE POLICY "prof_delete_admin" ON professionals
  FOR DELETE USING (
    tenant_id IN (
      SELECT tenant_id FROM tenant_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  );

-- Services
CREATE POLICY "svc_select" ON services
  FOR SELECT USING (
    tenant_id IN (
      SELECT tenant_id FROM tenant_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "svc_insert_admin" ON services
  FOR INSERT WITH CHECK (
    tenant_id IN (
      SELECT tenant_id FROM tenant_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  );

CREATE POLICY "svc_update_admin" ON services
  FOR UPDATE USING (
    tenant_id IN (
      SELECT tenant_id FROM tenant_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  );

CREATE POLICY "svc_delete_admin" ON services
  FOR DELETE USING (
    tenant_id IN (
      SELECT tenant_id FROM tenant_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  );

-- Clients
CREATE POLICY "cli_select" ON clients
  FOR SELECT USING (
    tenant_id IN (
      SELECT tenant_id FROM tenant_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "cli_insert" ON clients
  FOR INSERT WITH CHECK (
    tenant_id IN (
      SELECT tenant_id FROM tenant_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "cli_update" ON clients
  FOR UPDATE USING (
    tenant_id IN (
      SELECT tenant_id FROM tenant_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "cli_delete_admin" ON clients
  FOR DELETE USING (
    tenant_id IN (
      SELECT tenant_id FROM tenant_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  );

-- Appointments
CREATE POLICY "apt_select" ON appointments
  FOR SELECT USING (
    tenant_id IN (
      SELECT tenant_id FROM tenant_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "apt_insert" ON appointments
  FOR INSERT WITH CHECK (
    tenant_id IN (
      SELECT tenant_id FROM tenant_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "apt_update" ON appointments
  FOR UPDATE USING (
    tenant_id IN (
      SELECT tenant_id FROM tenant_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "apt_delete_admin" ON appointments
  FOR DELETE USING (
    tenant_id IN (
      SELECT tenant_id FROM tenant_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  );

-- WhatsApp logs
CREATE POLICY "wa_select" ON whatsapp_logs
  FOR SELECT USING (
    tenant_id IN (
      SELECT tenant_id FROM tenant_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "wa_insert" ON whatsapp_logs
  FOR INSERT WITH CHECK (
    tenant_id IN (
      SELECT tenant_id FROM tenant_members WHERE user_id = auth.uid()
    )
  );

-- Audit logs (read only for members)
CREATE POLICY "audit_select" ON audit_logs
  FOR SELECT USING (
    tenant_id IN (
      SELECT tenant_id FROM tenant_members WHERE user_id = auth.uid()
    )
  );

-- Subscriptions
CREATE POLICY "sub_select" ON tenant_subscriptions
  FOR SELECT USING (
    tenant_id IN (
      SELECT tenant_id FROM tenant_members WHERE user_id = auth.uid()
    )
  );

-- Functions

-- Update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply updated_at trigger to all tables
CREATE TRIGGER update_tenants_updated_at BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_professionals_updated_at BEFORE UPDATE ON professionals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_services_updated_at BEFORE UPDATE ON services
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_clients_updated_at BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_appointments_updated_at BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_tenant_subscriptions_updated_at BEFORE UPDATE ON tenant_subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to increment client stats
CREATE OR REPLACE FUNCTION increment_client_stats(client_uuid UUID, amount DECIMAL)
RETURNS VOID AS $$
BEGIN
  UPDATE clients
  SET
    total_appointments = total_appointments + 1,
    total_spent = total_spent + amount,
    last_appointment_at = NOW()
  WHERE id = client_uuid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get available slots for a professional on a date
CREATE OR REPLACE FUNCTION get_available_slots(
  p_professional_id UUID,
  p_service_id UUID,
  p_date DATE,
  p_tenant_id UUID
)
RETURNS TABLE (
  start_time TIME,
  end_time TIME,
  available BOOLEAN
) AS $$
DECLARE
  v_working_hours JSONB;
  v_slot_duration INTEGER;
  v_preparation_minutes INTEGER;
  v_day_of_week INTEGER;
  v_wh JSONB;
  v_open_time TIME;
  v_close_time TIME;
  v_is_closed BOOLEAN;
  v_breaks JSONB;
  v_current_minutes INTEGER;
  v_close_minutes INTEGER;
  v_slot_duration_min INTEGER;
  v_start_time TIME;
  v_end_time TIME;
  v_is_break BOOLEAN;
  v_has_conflict BOOLEAN;
BEGIN
  -- Get professional working hours for the day
  v_day_of_week := EXTRACT(DOW FROM p_date)::INTEGER;
  SELECT working_hours INTO v_working_hours FROM professionals WHERE id = p_professional_id;
  v_wh := v_working_hours->(v_day_of_week);

  IF v_wh IS NULL OR (v_wh->>'is_closed')::BOOLEAN THEN
    RETURN QUERY SELECT NULL::TIME, NULL::TIME, FALSE WHERE FALSE;
    RETURN;
  END IF;

  v_open_time := (v_wh->>'open_time')::TIME;
  v_close_time := (v_wh->>'close_time')::TIME;
  v_is_closed := (v_wh->>'is_closed')::BOOLEAN;
  v_breaks := v_wh->'breaks';

  -- Get tenant settings
  SELECT settings->>'slot_duration_minutes' INTO v_slot_duration FROM tenants WHERE id = p_tenant_id;
  v_slot_duration_min := COALESCE(v_slot_duration::INTEGER, 30);

  -- Get service preparation time
  SELECT preparation_minutes INTO v_preparation_minutes FROM services WHERE id = p_service_id;

  -- Get existing appointments for the day
  -- (This would be done in application code for better performance)

  -- Generate slots
  v_current_minutes := EXTRACT(HOUR FROM v_open_time) * 60 + EXTRACT(MINUTE FROM v_open_time);
  v_close_minutes := EXTRACT(HOUR FROM v_close_time) * 60 + EXTRACT(MINUTE FROM v_close_time);

  WHILE v_current_minutes + v_slot_duration_min <= v_close_minutes LOOP
    v_start_time := MAKE_TIME(
      (v_current_minutes / 60)::INTEGER,
      (v_current_minutes % 60)::INTEGER,
      0
    );
    v_end_time := MAKE_TIME(
      ((v_current_minutes + v_slot_duration_min) / 60)::INTEGER,
      ((v_current_minutes + v_slot_duration_min) % 60)::INTEGER,
      0
    );

    -- Check breaks
    v_is_break := FALSE;
    IF v_breaks IS NOT NULL THEN
      FOR i IN 0..jsonb_array_length(v_breaks) - 1 LOOP
        DECLARE
          v_break JSONB := v_breaks->i;
          v_break_start TIME := (v_break->>'start')::TIME;
          v_break_end TIME := (v_break->>'end')::TIME;
        BEGIN
          IF v_start_time >= v_break_start AND v_end_time <= v_break_end THEN
            v_is_break := TRUE;
            EXIT;
          END IF;
        END;
      END LOOP;
    END IF;

    -- Check conflicts (simplified - would be better in app code)
    v_has_conflict := FALSE;

    RETURN QUERY SELECT v_start_time, v_end_time, NOT v_is_break AND NOT v_has_conflict;

    v_current_minutes := v_current_minutes + v_slot_duration_min;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;