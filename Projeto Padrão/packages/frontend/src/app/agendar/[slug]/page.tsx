'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { formatDate, cn } from '@/lib/utils';
import { Calendar, Clock, User, Search, Plus, Check, ArrowRight, Loader2, Star, MapPin, Phone, Mail } from 'lucide-react';
import { tenantsApi, clientsApi, appointmentsApi, servicesApi, professionalsApi } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { DayPicker } from 'react-day-picker';
import { differenceInDays } from 'date-fns';
import { format } from 'date-fns-tz';

interface Tenant {
  id: string;
  name: string;
  slug: string;
  type: string;
  logo_url: string | null;
  primary_color: string;
  secondary_color: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  description: string | null;
  settings: any;
  professionals: any[];
  services: any[];
}

interface Service {
  id: string;
  name: string;
  duration_minutes: number;
  price: number;
  color: string | null;
}

interface Professional {
  id: string;
  name: string;
  avatar_url: string | null;
}

interface TimeSlot {
  start: string;
  end: string;
  available: boolean;
}

interface Client {
  id: string;
  name: string;
  phone: string;
  whatsapp: string | null;
  email: string | null;
}

export default function PublicBookingPage() {
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;

  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Booking flow state
  const [step, setStep] = useState(1); // 1: Service, 2: Professional/Date, 3: Time, 4: Client Info, 5: Confirm
  const [selectedService, setSelectedService] = useState<Service | null>(null);
  const [selectedProfessional, setSelectedProfessional] = useState<Professional | null>(null);
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(new Date());
  const [selectedTime, setSelectedTime] = useState('');
  const [slots, setSlots] = useState<TimeSlot[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);

  // Client form
  const [clientData, setClientData] = useState({
    name: '',
    phone: '',
    email: '',
    notes: '',
  });
  const [existingClient, setExistingClient] = useState<Client | null>(null);
  const [clientSearch, setClientSearch] = useState('');

  const fetchTenant = async () => {
    try {
      const data = await tenantsApi.getBySlug(slug);
      setTenant(data);
    } catch (err) {
      setError('Estabelecimento não encontrado');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTenant();
  }, [slug]);

  // Fetch slots when date/professional/service changes
  useEffect(() => {
    if (!selectedDate || !selectedProfessional || !selectedService || !tenant) {
      setSlots([]);
      return;
    }

    const fetchSlots = async () => {
      setLoadingSlots(true);
      try {
        const res = await appointmentsApi.getAvailability(tenant.id, {
          professional_id: selectedProfessional.id,
          service_id: selectedService.id,
          date: format(selectedDate, 'yyyy-MM-dd'),
        });
        const profAvailability = res.professionals?.find(
          (p: any) => p.professional_id === selectedProfessional.id
        );
        setSlots(profAvailability?.slots || []);
      } catch (err) {
        setSlots([]);
      } finally {
        setLoadingSlots(false);
      }
    };
    fetchSlots();
  }, [selectedDate, selectedProfessional, selectedService, tenant]);

  // Search existing client by phone
  useEffect(() => {
    const searchClient = async () => {
      if (clientSearch.length >= 10) {
        try {
          const res = await clientsApi.search(tenant!.id, clientSearch.replace(/\D/g, ''), 1);
          if (res.data.length > 0) {
            setExistingClient(res.data[0]);
            setClientData({
              name: res.data[0].name,
              phone: res.data[0].phone,
              email: res.data[0].email || '',
              notes: '',
            });
          } else {
            setExistingClient(null);
          }
        } catch (err) {
          setExistingClient(null);
        }
      } else {
        setExistingClient(null);
      }
    };

    const debounce = setTimeout(searchClient, 500);
    return () => clearTimeout(debounce);
  }, [clientSearch, tenant]);

  const handleTimeSelect = (slot: TimeSlot) => {
    if (!slot.available) return;
    setSelectedTime(slot.start);
    setStep(4);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      // Create or find client
      let clientId = existingClient?.id;
      if (!clientId) {
        const newClient = await clientsApi.create(tenant!.id, {
          name: clientData.name,
          phone: clientData.phone.replace(/\D/g, ''),
          email: clientData.email || null,
        });
        clientId = newClient.id;
      }

      // Create appointment
      const startsAt = `${format(selectedDate!, 'yyyy-MM-dd')}T${selectedTime}:00`;
      await appointmentsApi.create(tenant!.id, {
        client_id: clientId!,
        professional_id: selectedProfessional!.id,
        service_id: selectedService!.id,
        starts_at: startsAt,
        notes: clientData.notes,
      });

      router.push(`/agendar/${slug}/sucesso`);
    } catch (err: any) {
      alert(err.message || 'Erro ao agendar');
    }
  };

  const minDate = new Date();
  const maxDate = new Date();
  maxDate.setDate(maxDate.getDate() + (tenant?.settings?.advance_booking_days || 60));

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary" />
      </div>
    );
  }

  if (error || !tenant) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center p-8">
          <h1 className="text-2xl font-bold mb-2">Estabelecimento não encontrado</h1>
          <p className="text-muted-foreground">Verifique a URL e tente novamente</p>
        </div>
      </div>
    );
  }

  const tenantStyle = {
    backgroundColor: tenant.primary_color,
    color: '#fff',
  } as React.CSSProperties;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header style={tenantStyle} className="relative overflow-hidden">
        <div className="absolute inset-0 bg-black/10" />
        <div className="relative max-w-4xl mx-auto px-4 py-12">
          <div className="flex items-center gap-4 mb-4">
            {tenant.logo_url ? (
              <img src={tenant.logo_url} alt={tenant.name} className="h-16 w-16 rounded-lg bg-white/10 p-1" />
            ) : (
              <div className="h-16 w-16 rounded-lg bg-white/10 flex items-center justify-center">
                <Star className="h-8 w-8" />
              </div>
            )}
            <div>
              <h1 className="text-3xl font-bold">{tenant.name}</h1>
              <p className="text-white/90 capitalize">{tenant.type}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-4 text-white/90 text-sm">
            {tenant.address && (
              <span className="flex items-center gap-1"><MapPin className="h-4 w-4" />{tenant.address}</span>
            )}
            {tenant.phone && (
              <span className="flex items-center gap-1"><Phone className="h-4 w-4" />{tenant.phone}</span>
            )}
            {tenant.email && (
              <span className="flex items-center gap-1"><Mail className="h-4 w-4" />{tenant.email}</span>
            )}
          </div>
        </div>
      </header>

      {/* Progress */}
      <div className="max-w-4xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between">
          {[
            { num: 1, label: 'Serviço' },
            { num: 2, label: 'Profissional' },
            { num: 3, label: 'Horário' },
            { num: 4, label: 'Dados' },
            { num: 5, label: 'Confirmar' },
          ].map((s, i) => (
            <div key={s.num} className="flex items-center">
              <div
                className={cn(
                  'w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium',
                  step > s.num
                    ? 'bg-green-500 text-white'
                    : step === s.num
                    ? `bg-[${tenant.primary_color}] text-white`
                    : 'bg-gray-200 text-gray-500'
                )}
              >
                {step > s.num ? <Check className="h-4 w-4" /> : s.num}
              </div>
              <span className={cn('ml-1 text-xs font-medium hidden sm:block', step >= s.num ? '' : 'text-gray-400')}>
                {s.label}
              </span>
              {i < 4 && (
                <div
                  className={cn('hidden lg:block w-16 h-1 mx-1', step > i + 1 ? 'bg-green-500' : 'bg-gray-200')}
                />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Content */}
      <main className="max-w-4xl mx-auto px-4 pb-12">
        {error && (
          <div className="mb-6 p-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md">
            {error}
          </div>
        )}

        {/* Step 1: Service Selection */}
        {step === 1 && (
          <Card>
            <CardHeader>
              <CardTitle>Escolha o Serviço</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3">
                {tenant.services.map((service) => (
                  <button
                    key={service.id}
                    type="button"
                    onClick={() => {
                      setSelectedService(service);
                      setStep(2);
                    }}
                    className={cn(
                      'relative p-4 border-2 rounded-lg transition-all text-left h-full',
                      'border-gray-200 hover:border-primary/50'
                    )}
                  >
                    {service.color && (
                      <div className="absolute top-3 right-3 h-4 w-4 rounded-full" style={{ backgroundColor: service.color }} />
                    )}
                    <h3 className="font-medium mb-1">{service.name}</h3>
                    <p className="text-sm text-muted-foreground mb-2">
                      {service.duration_minutes} min
                    </p>
                    <p className="font-semibold text-lg">
                      R$ {service.price.toFixed(2).replace('.', ',')}
                    </p>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Step 2: Professional & Date */}
        {step === 2 && (
          <div className="space-y-6">
            {/* Professional Selection */}
            <Card>
              <CardHeader>
                <CardTitle>Escolha o Profissional</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3">
                  {tenant.professionals
                    .filter((p: any) => p.service_ids?.includes(selectedService!.id))
                    .map((prof: any) => (
                      <button
                        key={prof.id}
                        type="button"
                        onClick={() => {
                          setSelectedProfessional({ id: prof.id, name: prof.name, avatar_url: prof.avatar_url });
                          setStep(3);
                        }}
                        className={cn(
                          'relative p-4 border-2 rounded-lg transition-all text-left',
                          'border-gray-200 hover:border-primary/50'
                        )}
                      >
                        <div className="flex items-center gap-3">
                          <div className="h-12 w-12 rounded-full bg-gray-100 flex items-center justify-center">
                            {prof.avatar_url ? (
                              <img src={prof.avatar_url} alt={prof.name} className="h-12 w-12 rounded-full object-cover" />
                            ) : (
                              <User className="h-6 w-6 text-gray-400" />
                            )}
                          </div>
                          <div>
                            <p className="font-medium">{prof.name}</p>
                          </div>
                        </div>
                      </button>
                    ))}
                </div>
              </CardContent            </Card>
          </div>
        )}

        {/* Step 3: Date & Time */}
        {step === 3 && (
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Escolha a Data</CardTitle>
              </CardHeader>
              <CardContent>
                <DayPicker
                  mode="single"
                  selected={selectedDate}
                  onSelect={setSelectedDate}
                  fromDate={minDate}
                  toDate={maxDate}
                  classNames={{
                    root: 'w-full',
                    month: 'space-y-4',
                    caption: 'flex justify-center',
                    caption_label: 'text-lg font-medium',
                    nav: 'space-x-2',
                    nav_button: 'p-2 hover:bg-accent rounded-full',
                    table: 'w-full',
                    head_row: 'text-muted-foreground',
                    head_cell: 'text-center text-xs font-medium py-2',
                    cell: 'relative p-0 text-center',
                    day_button: 'w-10 h-10 rounded-full mx-auto',
                    day: 'text-center',
                    today: 'bg-primary/10 text-primary font-bold',
                    selected: `bg-[${tenant.primary_color}] text-white`,
                    disabled: 'text-muted-foreground/50 pointer-events-none',
                    outside: 'text-muted-foreground/30',
                  }}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Horários Disponíveis</CardTitle>
              </CardHeader>
              <CardContent>
                {selectedProfessional && selectedDate ? (
                  loadingSlots ? (
                    <div className="space-y-2">
                      {[1, 2, 3, 4, 5].map((i) => (
                        <div key={i} className="h-10 animate-pulse bg-gray-100 rounded" />
                      ))}
                    </div>
                  ) : slots.length === 0 ? (
                    <p className="text-center text-muted-foreground py-8">
                      Nenhum horário disponível para esta data
                    </p>
                  ) : (
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 max-h-96 overflow-y-auto">
                      {slots.map((slot) => (
                        <button
                          key={`${slot.start}-${slot.end}`}
                          type="button"
                          onClick={() => handleTimeSelect(slot)}
                          disabled={!slot.available}
                          className={cn(
                            'px-4 py-3 rounded-lg text-sm font-medium transition-all',
                            slot.available
                              ? 'bg-white border border-gray-200 hover:border-primary hover:bg-primary/5'
                              : 'bg-gray-100 border border-gray-200 text-gray-400 cursor-not-allowed'
                          )}
                        >
                          <div className="font-medium">{slot.start}</div>
                          <div className="text-xs text-muted-foreground">até {slot.end}</div>
                        </button>
                      ))}
                    </div>
                  )
                ) : (
                  <p className="text-center text-muted-foreground py-8">
                    Selecione um profissional e data para ver horários
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* Step 4: Client Info */}
        {step === 4 && (
          <Card>
            <CardHeader>
              <CardTitle>Seus Dados</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="phone">Telefone/WhatsApp</Label>
                <div className="relative">
                  <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="phone"
                    placeholder="(11) 99999-9999"
                    value={clientData.phone}
                    onChange={(e) => {
                      const value = e.target.value.replace(/\D/g, '');
                      setClientData(prev => ({ ...prev, phone: value }));
                      setClientSearch(value);
                    }}
                    className="pl-10"
                  />
                </div>
                {existingClient && (
                  <p className="text-sm text-green-600">Cliente encontrado: {existingClient.name}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="name">Nome Completo</Label>
                <Input
                  id="name"
                  placeholder="Seu nome completo"
                  value={clientData.name}
                  onChange={(e) => setClientData(prev => ({ ...prev, name: e.target.value }))}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="email">E-mail (opcional)</Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="email"
                    type="email"
                    placeholder="seu@email.com"
                    value={clientData.email}
                    onChange={(e) => setClientData(prev => ({ ...prev, email: e.target.value }))}
                    className="pl-10"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="notes">Observações (opcional)</Label>
                <Textarea
                  id="notes"
                  placeholder="Alguma observação para o profissional?"
                  value={clientData.notes}
                  onChange={(e) => setClientData(prev => ({ ...prev, notes: e.target.value }))}
                  rows={3}
                />
              </div>
            </CardContent>
          </Card>
        )}

        {/* Step 5: Confirmation */}
        {step === 5 && (
          <Card>
            <CardHeader>
              <CardTitle>Confirmar Agendamento</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-1 p-4 bg-gray-50 rounded-lg">
                  <p className="text-sm text-muted-foreground">Serviço</p>
                  <p className="font-medium">{selectedService?.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {selectedService?.duration_minutes}min · R$ {selectedService?.price.toFixed(2).replace('.', ',')}
                  </p>
                </div>
                <div className="space-y-1 p-4 bg-gray-50 rounded-lg">
                  <p className="text-sm text-muted-foreground">Profissional</p>
                  <p className="font-medium">{selectedProfessional?.name}</p>
                </div>
                <div className="space-y-1 p-4 bg-gray-50 rounded-lg">
                  <p className="text-sm text-muted-foreground">Data</p>
                  <p className="font-medium">{formatDate(selectedDate!)}</p>
                </div>
                <div className="space-y-1 p-4 bg-gray-50 rounded-lg">
                  <p className="text-sm text-muted-foreground">Horário</p>
                  <p className="font-medium">{selectedTime}</p>
                </div>
              </div>

              <div className="space-y-1 p-4 bg-gray-50 rounded-lg">
                <p className="text-sm text-muted-foreground">Cliente</p>
                <p className="font-medium">{clientData.name}</p>
                <p className="text-sm text-muted-foreground">{clientData.phone}</p>
                {clientData.email && <p className="text-sm text-muted-foreground">{clientData.email}</p>}
              </div>

              <div className="flex justify-end gap-2 pt-4 border-t">
                <Button variant="outline" onClick={() => setStep(4)}>
                  Voltar
                </Button>
                <Button onClick={handleSubmit} style={{ backgroundColor: tenant.primary_color }}>
                  <Check className="mr-2 h-4 w-4" />Confirmar Agendamento
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Navigation */}
        <div className="flex justify-between mt-6">
          <Button variant="outline" onClick={() => setStep(Math.max(1, step - 1))} disabled={step === 1}>
            Voltar
          </Button>
          {step < 5 && (
            <Button onClick={() => setStep(step + 1)} disabled={loadingSlots}>
              {step === 4 ? 'Confirmar' : 'Próximo'}
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t py-8 px-4">
        <div className="max-w-4xl mx-auto text-center text-sm text-muted-foreground">
          <p>Agendamento online via Agenda Pro</p>
        </div>
      </footer>
    </div>
  );
}