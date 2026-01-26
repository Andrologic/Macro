export const MOCK_CODE_FILES: Record<string, { content: string; language: string }> = {
  'src-tauri/src/commands/auth.rs': {
    language: 'rust',
    content: `use tauri::command;
use crate::models::{User, LoginCredentials};

#[command]
pub async fn login(credentials: LoginCredentials) -> Result<User, String> {
    println!("Logging in user: {}", credentials.email);
    // Simulation d'une authentification
    Ok(User {
        id: "user-1".to_string(),
        email: credentials.email,
        name: "John Doe".to_string(),
    })
}

#[command]
pub async fn register(user: User) -> Result<User, String> {
    Ok(user)
}

#[command]
pub async fn logout() -> Result<(), String> {
    Ok(())
}`
  },
  'src/hooks/useAuth.ts': {
    language: 'typescript',
    content: `import { useContext } from 'react';
import { AuthContext } from '../contexts/AuthContext';

/**
 * Hook personnalisé pour accéder au contexte d'authentification
 */
export const useAuth = () => {
  const context = useContext(AuthContext);
  
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  
  return context;
};`
  },
  'demo-feature.tsx': {
    language: 'typescript',
    content: `// DÉMO: Visualisation de fichier avec modifications suggérées
import React from 'react';
import { Button } from './ui/Button';

export const FeatureDemo = () => {
  // <<<<< MODIFICATION SUGGÉRÉE >>>>>
  // Ajout d'un état pour gérer l'interaction
  const [active, setActive] = React.useState(false);

  return (
    <div className="p-6 bg-zinc-900 rounded-xl border border-zinc-800">
      <h2 className="text-xl font-bold text-white mb-4">
        Visualiseur de Code
      </h2>
      <p className="text-zinc-400 mb-6">
        Cette modal permet de consulter le code source directement
        depuis l'arborescence Git.
      </p>
      
      {/* BOUTON D'ACTION AJOUTÉ */}
      <Button 
        variant={active ? "primary" : "secondary"}
        onClick={() => setActive(!active)}
      >
        {active ? "Activé" : "Désactivé"}
      </Button>
    </div>
  );
};`
  }
};
