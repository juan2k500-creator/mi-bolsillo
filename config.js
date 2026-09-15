// Datos de conexión con Supabase.
// Se sacan de: Supabase → tu proyecto → Project Settings → API.
// La "anon public key" está hecha para ir en la página: los datos los protege
// la seguridad por usuario de la base (supabase.sql), no esta clave.
// Si se dejan vacíos, la app abre en "modo prueba" y guarda solo en este navegador.
window.MI_BOLSILLO_CONFIG = {
  supabaseUrl: 'https://yzumbtdclpulvbnzswhg.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl6dW1idGRjbHB1bHZibnpzd2hnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk0MzY4MDksImV4cCI6MjEwNTAxMjgwOX0.RdTQ4PdhDv4Fthlko4b-Ov5WfszxZ7ZDC8jf24zAFbY',  // la clave larga "anon public"
};
