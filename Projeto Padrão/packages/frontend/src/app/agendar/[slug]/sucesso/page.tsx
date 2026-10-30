'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CheckCircle, Calendar, Clock, User, Star, ArrowRight, Home } from 'lucide-react';
import { tenantsApi } from '@/lib/api';
import { formatDate } from '@/lib/utils';

interface AppointmentDetails {
  service_name: string;
  professional_name: string;
  date: string;
  time: string;
  client_name: string;
  tenant_name: string;
  tenant_address: string | null;
  tenant_phone: string | null;
}

export default function BookingSuccessPage() {
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;

  const [details, setDetails] = useState<AppointmentDetails | null>(null);
  const [tenant, setTenant] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Get appointment details from sessionStorage (set during booking)
    const stored = sessionStorage.getItem(`booking_${slug}`);
    if (stored) {
      try {
        const data = JSON.parse(stored);
        setDetails(data);
        sessionStorage.removeItem(`booking_${slug}`);
      } catch (err) {
        console.error('Error parsing booking data', err);
      }
    }

    // Fetch tenant info
    tenantsApi.getBySlug(slug).then(setTenant).catch(console.error).finally(() => setLoading(false));
  }, [slug]);

  const handleNewBooking = () => {
    router.push(`/agendar/${slug}`);
    router.refresh();
  };

  const handleGoHome = () => {
    router.push('/');
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary" />
      </div>
    );
  }

  if (!details) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center p-8">
          <CheckCircle className="h-16 w-16 text-green-500 mx-auto mb-4" />
          <h1 className="text-2xl font-bold mb-2">Agendamento Confirmado!</h1>
          <p className="text-muted-foreground mb-6">Seu agendamento foi realizado com sucesso.</p>
          <div className="flex gap-4 justify-center">
            <Button onClick={handleNewBooking}>Novo Agendamento</Button>
            <Button variant="outline" onClick={handleGoHome}>Voltar ao Início</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-2xl mx-auto">
        {/* Success Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-green-100 text-green-600 mb-4">
            <CheckCircle className="h-10 w-10" />
          </div>
          <h1 className="text-3xl font-bold mb-2">Agendamento Confirmado!</h1>
          <p className="text-muted-foreground">Seu horário foi reservado com sucesso. Enviamos os detalhes para seu WhatsApp.</p>
        </div>

        {/* Appointment Card */}
        <Card className="mb-6">
          <CardContent className="pt-6">
            <div className="space-y-4">
              <div className="flex items-center gap-4 p-4 bg-gray-50 rounded-lg">
                <div className="p-3 rounded-full bg-primary/10 text-primary">
                  <Star className="h-6 w-6" />
                </div>
                <div>
                  <p className="font-medium text-lg">{details.service_name}</p>
                  <p className="text-sm text-muted-foreground">Com {details.professional_name}</p>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                  <Calendar className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm text-muted-foreground">Data</p>
                    <p className="font-medium">{formatDate(details.date)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                  <Clock className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm text-muted-foreground">Horário</p>
                    <p className="font-medium">{details.time}</p>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                <User className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="text-sm text-muted-foreground">Cliente</p>
                  <p className="font-medium">{details.client_name}</p>
                </div>
              </div>

              {tenant && (
                <div className="border-t pt-4">
                  <p className="font-medium mb-2">{tenant.name}</p>
                  <p className="text-sm text-muted-foreground">{tenant.address || 'Endereço não informado'}</p>
                  {tenant.phone && (
                    <p className="text-sm text-muted-foreground mt-1">📞 {tenant.phone}</p>
                  )}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* WhatsApp Info */}
        <Card className="mb-6 border-green-200 bg-green-50">
          <CardContent className="pt-6">
            <div className="flex items-center gap-3 text-green-800">
              <svg className="h-6 w-6" fill="currentColor" viewBox="0 0 24 24">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.386-1.63-1.52-.166-.153-.14-.27.05-.42.173-.15.302-.3.54-.467.257-.182.478-.386.66-.586.197-.217.378-.454.548-.717.167-.26.13-.345-.03-.48-.143-.118-.338-.242-.567-.36-.244-.127-.512-.215-.804-.272-.28-.054-.52-.054-.767.054-.247.108-.448.27-.67.467-.207.19-.43.4-.64.627-.228.244-.47.527-.708.813-.33.395-.59.786-.804 1.173-.213.387-.374.746-.48.994-.106.248-.09.302-.032.397.062.1.268.297.813.845.497.497 1.112 1.118 1.435 1.37.246.197.477.374.694.538.228.174.474.32.705.44.293.16.59.258.893.258.187 0 .527-.04.86-.149.42-.14.808-.417 1.16-.856.352-.439.56-.88.56-1.268 0-.27-.054-.484-.15-.658-.105-.184-.23-.33-.4-.487zM12 2C6.486 2 2 6.486 2 12c0 1.821.487 3.53 1.338 5.011C2.259 18.55 1.006 17.335.477 15.637c-.397-1.267-.32-2.634.343-3.793.607-1.06 1.84-1.863 3.231-2.44 1.12-.473 2.155-.892 3.202-1.23.975-.316 1.95-.574 2.94-.77 1.006-.19 2.01-.275 3.02-.275 1.02 0 2.02.084 3.02.284.99.196 1.97.465 2.96.785 1.08.347 2.11.774 3.21 1.237 1.38.56 2.6 1.35 3.19 2.39.68.7.92 1.95.42 3.15-.482 1.08-1.435 2.49-3.62 3.75-1.15.65-2.49 1.16-4.24 1.16-3.27 0-6.25-2.23-7.26-5.32C3.76 15.57 2 12.87 2 12c0-5.514 4.486-10 10-10z"/>
              </svg>
              <p className="text-sm">Confirmação e lembrete enviados via WhatsApp</p>
            </div>
          </CardContent>
        </Card>

        {/* Actions */}
        <div className="flex gap-4">
          <Button className="flex-1" size="lg" onClick={handleNewBooking}>
            <Calendar className="mr-2 h-4 w-4" />
            Novo Agendamento
          </Button>
          <Button variant="outline" className="flex-1" size="lg" onClick={handleGoHome}>
            <Home className="mr-2 h-4 w-4" />
            Início
          </Button>
        </div>

        <p className="text-center text-sm text-muted-foreground mt-8">
          Dúvidas? Entre em contato: {tenant?.phone || tenant?.email || 'pelo WhatsApp'}
        </p>
      </div>
    </div>
  );
}