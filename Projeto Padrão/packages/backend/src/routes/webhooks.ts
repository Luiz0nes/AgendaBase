import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getSupabaseAdminClient } from '../config/supabase';
import { AppError } from '../utils/errors';

export async function webhookRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();
  const supabase = getSupabaseAdminClient();

  // Evolution API webhook
  server.post(
    '/evolution',
    {
      schema: {
        body: z.object({
          event: z.enum(['messages.upsert', 'messages.update', 'connection.update', 'qr.updated']),
          instance: z.string(),
          data: z.any(),
        }),
      },
    },
    async (request, reply) => {
      const { event, instance, data } = request.body;

      console.log(`Evolution webhook: ${event}`, JSON.stringify(data, null, 2));

      try {
        switch (event) {
          case 'messages.upsert': {
            // New message received
            const messages = data.messages || [data];
            for (const msg of messages) {
              await handleIncomingMessage(msg);
            }
            break;
          }
          case 'messages.update': {
            // Message status update (sent, delivered, read)
            await handleMessageUpdate(data);
            break;
          }
          case 'connection.update': {
            // Connection status change
            await handleConnectionUpdate(data);
            break;
          }
        }

        return { success: true };
      } catch (error) {
        console.error('Webhook error:', error);
        // Return 200 to avoid retries
        return { success: false, error: 'Internal error' };
      }
    }
  );

  async function handleIncomingMessage(msg: any) {
    // Only process text messages from users (not from me)
    if (msg.key?.fromMe || msg.messageType !== 'conversation') return;

    const phone = msg.key?.remoteJid?.replace('@s.whatsapp.net', '');
    const text = msg.message?.conversation || '';

    if (!phone || !text) return;

    // Find client by phone
    const { data: client } = await supabase
      .from('clients')
      .select('id, tenant_id, name')
      .or(`phone.eq.${phone},whatsapp.eq.${phone}`)
      .single();

    if (!client) return;

    // Log incoming message
    await supabase.from('whatsapp_logs').insert({
      tenant_id: client.tenant_id,
      client_id: client.id,
      phone,
      message_type: 'text',
      content: text,
      status: 'received',
      evolution_message_id: msg.key?.id,
    });

    // Simple auto-reply for common keywords
    const lowerText = text.toLowerCase().trim();
    let replyText = '';

    if (lowerText.includes('cancelar') || lowerText.includes('cancelamento')) {
      replyText = 'Para cancelar seu agendamento, por favor responda com o código do agendamento ou entre em contato conosco diretamente.';
    } else if (lowerText.includes('reagendar') || lowerText.includes('mudar')) {
      replyText = 'Para reagendar, por favor informe a nova data e horário desejados ou entre em contato conosco.';
    } else if (lowerText.includes('confirmar') || lowerText.includes('ok') || lowerText === 'sim') {
      // Try to find pending appointment
      const { data: pendingAppt } = await supabase
        .from('appointments')
        .select('id, status')
        .eq('client_id', client.id)
        .eq('tenant_id', client.tenant_id)
        .eq('status', 'pending')
        .order('starts_at', { ascending: true })
        .limit(1)
        .single();

      if (pendingAppt) {
        await supabase
          .from('appointments')
          .update({ status: 'confirmed', confirmation_sent: true })
          .eq('id', pendingAppt.id);

        replyText = 'Seu agendamento foi confirmado! ✅';
      }
    } else if (lowerText === 'menu' || lowerText === 'ajuda' || lowerText === 'help') {
      replyText = `Olá ${client.name}! 👋

Comandos disponíveis:
• *CONFIRMAR* - Confirmar agendamento pendente
• *CANCELAR* - Cancelar agendamento
• *REAGENDAR* - Mudar data/horário
• *MENU* - Ver esta ajuda

Ou fale com nossa equipe para atendimento personalizado.`;
    }

    if (replyText) {
      // Send reply via Evolution API
      try {
        const { sendTextMessage } = await import('../config/evolution');
        await sendTextMessage({ number: phone, text: replyText });

        await supabase.from('whatsapp_logs').insert({
          tenant_id: client.tenant_id,
          client_id: client.id,
          phone,
          message_type: 'text',
          content: replyText,
          status: 'sent',
        });
      } catch (error) {
        console.error('Failed to send auto-reply:', error);
      }
    }
  }

  async function handleMessageUpdate(data: any) {
    const { key, status } = data;

    if (!key?.id) return;

    // Update message status in logs
    const { error } = await supabase
      .from('whatsapp_logs')
      .update({
        status: mapStatus(status),
        delivered_at: status === 'delivered' ? new Date().toISOString() : undefined,
        read_at: status === 'read' ? new Date().toISOString() : undefined,
      })
      .eq('evolution_message_id', key.id);

    if (error) {
      console.error('Failed to update message status:', error);
    }
  }

  async function handleConnectionUpdate(data: any) {
    const { state } = data;
    console.log(`WhatsApp connection state: ${state}`);

    // Could update tenant settings or notify admins
  }

  function mapStatus(status: string): 'sent' | 'delivered' | 'read' | 'failed' {
    switch (status) {
      case 'sent': return 'sent';
      case 'delivered': return 'delivered';
      case 'read': return 'read';
      default: return 'failed';
    }
  }

  // Test webhook endpoint
  server.get('/evolution/test', async (request, reply) => {
    return { success: true, message: 'Webhook endpoint is working' };
  });
}