import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
	throw new Error(
		'Faltan variables de entorno de Supabase. Define VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY en .env'
	);
}

// Este es el "mensajero" que enviará las peticiones a Supabase
export const supabase = createClient(supabaseUrl, supabaseAnonKey);