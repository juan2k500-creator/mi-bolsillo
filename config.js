// Datos de conexión con Supabase.
// Se sacan de: Supabase → tu proyecto → Project Settings → API.
// La "anon public key" está hecha para ir en la página: los datos los protege
// la seguridad por usuario de la base (supabase.sql), no esta clave.
// Si se dejan vacíos, la app abre en "modo prueba" y guarda solo en este navegador.
window.MI_BOLSILLO_CONFIG = {
  supabaseUrl: '',      // ejemplo: 'https://abcdefghijkl.supabase.co'
  supabaseAnonKey: '',  // la clave larga "anon public"
};
