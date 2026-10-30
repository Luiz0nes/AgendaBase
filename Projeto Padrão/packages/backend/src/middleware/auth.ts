import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getSupabaseClient, getSupabaseAdminClient, getUserFromToken, verifyTenantAccess } from '../config/supabase';
import { AppError } from '../utils/errors';
import { getEnv } from '../config/env';

export interface AuthenticatedRequest extends FastifyRequest {
  user: {
    id: string;
    email: string;
    role: string;
    tenant_id: string;
    professional_id: string | null;
  };
}

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw AppError.unauthorized('Token de acesso não fornecido');
  }

  const token = authHeader.substring(7);

  try {
    const user = await getUserFromToken(token);

    if (!user) {
      throw AppError.unauthorized('Token inválido ou expirado');
    }

    // Get user's tenant membership
    const supabase = getSupabaseAdminClient();
    const { data: membership, error } = await supabase
      .from('tenant_members')
      .select('tenant_id, role, professional_id')
      .eq('user_id', user.id)
      .single();

    if (error || !membership) {
      throw AppError.forbidden('Usuário não pertence a nenhuma organização');
    }

    (request as AuthenticatedRequest).user = {
      id: user.id,
      email: user.email!,
      role: membership.role,
      tenant_id: membership.tenant_id,
      professional_id: membership.professional_id,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw AppError.unauthorized('Erro ao validar token');
  }
}

export function requireRole(...allowedRoles: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const authRequest = request as AuthenticatedRequest;

    if (!authRequest.user) {
      throw AppError.unauthorized('Não autenticado');
    }

    if (!allowedRoles.includes(authRequest.user.role)) {
      throw AppError.forbidden('Permissão insuficiente');
    }
  };
}

export function requireTenantAccess() {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const authRequest = request as AuthenticatedRequest;
    const tenantId = (request.params as any).tenant_id || (request.body as any).tenant_id;

    if (!tenantId) return; // No tenant check needed

    if (authRequest.user.tenant_id !== tenantId) {
      throw AppError.forbidden('Acesso negado a esta organização');
    }
  };
}

export function requireProfessionalAccess() {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const authRequest = request as AuthenticatedRequest;
    const professionalId = (request.params as any).professional_id || (request.body as any).professional_id;

    if (!professionalId) return;

    if (authRequest.user.professional_id !== professionalId && authRequest.user.role !== 'owner' && authRequest.user.role !== 'admin') {
      throw AppError.forbidden('Acesso negado a este profissional');
    }
  };
}

// Optional authentication - doesn't throw if no token
export async function optionalAuthenticate(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return;
  }

  try {
    await authenticate(request, reply);
  } catch {
    // Ignore auth errors for optional auth
  }
}

// Generate tenant-scoped JWT for frontend
export async function generateTenantToken(userId: string, tenantId: string, role: string, professionalId: string | null) {
  const env = getEnv();
  const supabase = getSupabaseAdminClient();

  // Create a custom JWT with tenant context
  const payload = {
    sub: userId,
    tenant_id: tenantId,
    role,
    professional_id: professionalId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60, // 7 days
  };

  // In production, use a proper JWT library with the secret
  // For now, we'll use Supabase's built-in session
  const { data, error } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email: (await supabase.auth.admin.getUserById(userId)).data.user?.email!,
    options: {
      redirectTo: `${env.FRONTEND_URL}/auth/callback`,
    },
  });

  if (error) throw AppError.internal('Erro ao gerar token');

  return data.properties?.action_link;
}

// Verify webhook signature (for Evolution API)
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const crypto = require('crypto');
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}