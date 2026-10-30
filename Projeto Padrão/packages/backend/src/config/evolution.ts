import axios, { AxiosInstance } from 'axios';
import { getEnv } from './env';

let evolutionClient: AxiosInstance | null = null;

export function getEvolutionClient(): AxiosInstance {
  if (evolutionClient) return evolutionClient;

  const env = getEnv();

  evolutionClient = axios.create({
    baseURL: `${env.EVOLUTION_API_URL}/instance/${env.EVOLUTION_INSTANCE_NAME}`,
    headers: {
      'Content-Type': 'application/json',
      'apikey': env.EVOLUTION_API_KEY,
    },
    timeout: 30000,
  });

  // Interceptor for logging
  evolutionClient.interceptors.response.use(
    (response) => response,
    (error) => {
      console.error('Evolution API Error:', error.response?.data || error.message);
      return Promise.reject(error);
    }
  );

  return evolutionClient;
}

export interface SendTextMessageParams {
  number: string;
  text: string;
  delay?: number;
  linkPreview?: boolean;
}

export interface SendTemplateMessageParams {
  number: string;
  templateName: string;
  languageCode: string;
  components: Array<{
    type: 'header' | 'body' | 'button';
    parameters: Array<{
      type: 'text' | 'currency' | 'date_time';
      text?: string;
      currency?: { fallback_value: string; code: string; amount_1000: number };
      date_time?: string;
    }>;
  }>;
}

export async function sendTextMessage(params: SendTextMessageParams) {
  const client = getEvolutionClient();
  const response = await client.post('/messages/text', {
    number: params.number,
    text: params.text,
    delay: params.delay ?? 1200,
    linkPreview: params.linkPreview ?? false,
  });
  return response.data;
}

export async function sendTemplateMessage(params: SendTemplateMessageParams) {
  const client = getEvolutionClient();
  const response = await client.post('/messages/template', {
    number: params.number,
    templateName: params.templateName,
    languageCode: params.languageCode,
    components: params.components,
  });
  return response.data;
}

export async function getInstanceStatus() {
  const client = getEvolutionClient();
  const response = await client.get('/connectionState');
  return response.data;
}

export async function logoutInstance() {
  const client = getEvolutionClient();
  const response = await client.delete('/logout');
  return response.data;
}

// Appointment confirmation message templates
export const WHATSAPP_TEMPLATES = {
  APPOINTMENT_CONFIRMED: (data: {
    clientName: string;
    serviceName: string;
    professionalName: string;
    date: string;
    time: string;
    address: string;
    tenantName: string;
  }) => `Olá ${data.clientName}! ✂️

Seu agendamento foi *confirmado* na ${data.tenantName}:

📅 *Data:* ${data.date}
⏰ *Horário:* ${data.time}
💇 *Serviço:* ${data.serviceName}
👤 *Profissional:* ${data.professionalName}
📍 *Endereço:* ${data.address}

Caso precise cancelar ou reagendar, responda esta mensagem ou entre em contato conosco.

Até breve! 😊`,

  APPOINTMENT_REMINDER: (data: {
    clientName: string;
    serviceName: string;
    professionalName: string;
    date: string;
    time: string;
    tenantName: string;
  }) => `Olá ${data.clientName}! ⏰

Lembrete do seu agendamento *amanhã* na ${data.tenantName}:

📅 *Data:* ${data.date}
⏰ *Horário:* ${data.time}
💇 *Serviço:* ${data.serviceName}
👤 *Profissional:* ${data.professionalName}

Nos vemos amanhã! 😊`,

  APPOINTMENT_CANCELLED: (data: {
    clientName: string;
    serviceName: string;
    date: string;
    time: string;
    tenantName: string;
  }) => `Olá ${data.clientName},

Seu agendamento na ${data.tenantName} foi *cancelado*:

📅 *Data:* ${data.date}
⏰ *Horário:* ${data.time}
💇 *Serviço:* ${data.serviceName}

Para reagendar, entre em contato conosco.

Atenciosamente,
Equipe ${data.tenantName}`,

  APPOINTMENT_RESCHEDULED: (data: {
    clientName: string;
    serviceName: string;
    professionalName: string;
    oldDate: string;
    oldTime: string;
    newDate: string;
    newTime: string;
    tenantName: string;
  }) => `Olá ${data.clientName}!

Seu agendamento na ${data.tenantName} foi *reagendado*:

📅 *Nova data:* ${data.newDate}
⏰ *Novo horário:* ${data.newTime}
💇 *Serviço:* ${data.serviceName}
👤 *Profissional:* ${data.professionalName}

---
*Agendamento anterior:*
📅 ${data.oldDate} às ${data.oldTime}

Qualquer dúvida, estamos à disposição! 😊`,
};