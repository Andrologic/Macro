# Frontend Plan - Macro

## Architecture Frontend

### Stack Technique
- **React 18** + **TypeScript** (stricte)
- **Vite** (build tool)
- **TailwindCSS** (styling utility-first)
- **Shadcn/ui** (composants UI réutilisables)
- **Zustand** (state global)
- **Jotai** (state composant)
- **CodeMirror 6** (éditeur de code)

### Structure des Dossiers

```
src/
├── components/
│   ├── ui/              # Composants Shadcn/ui
│   ├── editor/          # CodeMirror 6
│   ├── chat/            # Interface de chat
│   ├── sidebar/         # Panneaux gauche/droite
│   ├── plans/           # Mode Architecte
│   └── tasks/           # Mode Implémentation
├── stores/
│   ├── useAppStore.ts   # State global (Zustand)
│   ├── useEditorStore.ts # State éditeur
│   ├── useProjectStore.ts # State projets
│   └── useChatStore.ts  # State chat/tâches
├── hooks/
│   ├── useAI.ts         # Hook IA
│   ├── useGit.ts        # Hook git
│   └── useFileSystem.ts # Hook système fichiers
├── types/
│   ├── project.ts       # Types projets
│   ├── plan.ts          # Types plans
│   ├── task.ts          # Types tâches
│   └── ai.ts            # Types IA
├── utils/
│   ├── codeMirror.ts    # Extensions CodeMirror
│   └── format.ts        # Utilitaires formatage
├── App.tsx
└── main.tsx
```

---

## Layout Principal

### Structure de l'Interface

```
┌─────────────────────────────────────────────────────────────────────────┐
│ ╔═══════════════════════════════╗  ╔══════════════════════════════════╗ │
│ ║ Panneau Gauche               ║  ║ Panneau Droit                   ║ │
│ ║ (Groupes de Projets)         ║  ║ (Arbres Git)                   ║ │
│ ║                              ║  ║                                 ║ │
│ ║ ┌──────────────────────────┐ ║  ║ ┌─────────────────────────────┐ ║ │
│ ║ │ Groupe 1                 │ ║  ║ │ Projet A [main]             │ ║ │
│ ║ │  ├─ Frontend ✓           │ ║  ║ │ 📂 src/                     │ ║ │
│ ║ │  └─ Backend ✓           │ ║  ║ │  ├─ App.tsx         [+]    │ ║ │
│ ║ └──────────────────────────┘ ║  ║ │  ├─ main.tsx        [+]    │ ║ │
│ ║                              ║  ║ │  └─ ...                    │ ║ │
│ ║ ┌──────────────────────────┐ ║  ║ │ 📄 package.json             │ ║ │
│ ║ │ Groupe 2                 │ ║  ║ │                             │ ║ │
│ ║ │  ├─ Mobile App ✓        │ ║  ║ │ ▶ 3 modifications           │ ║ │
│ ║ │  └─ API Gateway ✓       │ ║  ║ └─────────────────────────────┘ ║ │
│ ║ └──────────────────────────┘ ║  ║                                 ║ │
│ ║                              ║  ║ ┌─────────────────────────────┐ ║ │
│ ║ [+ Ajouter Groupe]           ║  ║ │ Projet B [feature/auth]     │ ║ │
│ ║                              ║  ║ │ 📂 src/                     │ ║ │
│ ╚═══════════════════════════════╝  ║ │  ├─ auth/           [M]    │ ║ │
│                                  ║ │  └─ ...                    │ ║ │
│ ╔════════════════════════════════╗║ │                             │ ║ │
│ ║ Zone Chat (Toujours Visible)   ║║ │ ▶ 5 modifications           │ ║ │
│ ║                                ║║ └─────────────────────────────┘ ║ │
│ ║ 📋 Tâches Actives (5)         ║║                                 ║ │
│ ║                                ║║ [Onglet pour chaque projet]    ║ │
│ ║ ○ [Frontend] Implémenter auth ║║                                 ║ │
│ ║   ├─ Dernier msg: IA demande  ║║                                 ║ │
│ ║   │  le type d'utilisateur... ║║                                 ║ │
│ ║   └─ ▶ Répondre               ║║                                 ║ │
│ ║                                ║║                                 ║ │
│ ║ ○ [Backend] Créer endpoint... ║║                                 ║ │
│ ║   └─ En attente de Frontend   ║║                                 ║ │
│ ║                                ║║                                 ║ │
│ ║ ╔═══════════════════════════╗ ║║                                 ║ │
│ ║ ║ [Éditeur - Read Only]    ║ ║║                                 ║ │
│ ║ ║                          ║ ║║                                 ║ │
│ ║ ║ // Code généré par IA    ║ ║║                                 ║ │
│ ║ ║                          ║ ║║                                 ║ │
│ ║ ╚═══════════════════════════╝ ║║                                 ║ │
│ ║                                ║║                                 ║ │
│ ╚════════════════════════════════╝║                                 ║ │
│                                  ╚══════════════════════════════════╝ │
└─────────────────────────────────────────────────────────────────────────┘
```

### Étapes d'Utilisation

1. **Créer un Plan** (Mode Architecte)
   - L'utilisateur entre une description de feature
   - L'IA génère un plan structuré avec tâches
   - L'arbre git prédit apparaît dans le panneau droit

2. **Naviguer les Tâches**
   - Liste de tâches unifiée dans la zone chat
   - Chaque tâche marque son projet d'appartenance
   - Filtrage par projet, priorité, statut

3. **Exécuter Tâches** (Mode Implémentation)
   - L'IA exécute les modifications
   - Modifications affichées dans le chat pour révision
   - Clic sur modification → diff popup détaillé
   - Approbation/Réjet atomique (tous les projets ensemble)

---

## Composants Principaux

### 1. AppLayout (Composant Racine)
```tsx
// Responsabilités:
// - Structure des 3 panneaux (gauche, centre, droit)
// - Gestion des modes (Architecte vs Implémentation)
// - État global de l'application
```

### 2. LeftPanel - Gestion des Projets
```tsx
// Responsabilités:
// - Afficher les groupes de projets verticaux
// - Gérer l'état ouvert/fermé des projets
// - Navigation entre projets
// - Métadonnées projet (tags, description)

// Structure:
<ProjectGroup>
  <ProjectGroupHeader title="Groupe 1" />
  <ProjectList>
    <ProjectItem name="Frontend" status="active" />
    <ProjectItem name="Backend" status="active" />
  </ProjectList>
</ProjectGroup>
```

### 3. ChatZone - Centre de l'Application
```tsx
// Responsabilités:
// - Liste de tâches unifiée (multi-projet)
// - Interface de chat IA
// - Éditeur CodeMirror (read-only)
// - Diff popup pour révision des modifications

// Structure:
<TaskList>
  <TaskItem project="Frontend" status="in-progress">
    Implémenter auth
    <ChatMessages />
    <ChatInput />
  </TaskItem>
</TaskList>

<CodeEditor readOnly={true} />
```

### 4. RightPanel - Arbres Git
```tsx
// Responsabilités:
// - Afficher arbre git prédit par projet
// - Visualiser les modifications prévues
// - Onglets pour basculer entre projets
// - Statistiques (nombre de fichiers modifiés)

// Structure:
<GitTrees>
  <Tabs>
    <Tab title="Projet A">
      <GitTree structure={predictedTree} />
    </Tab>
    <Tab title="Projet B">
      <GitTree structure={predictedTree} />
    </Tab>
  </Tabs>
</GitTrees>
```

### 5. ArchitectMode - Création de Plans
```tsx
// Responsabilités:
// - Input pour description de feature
// - Visualisation du plan généré
// - Validation des tâches avant exécution
// - Prédiction d'arbre git

// Structure:
<PlanCreator>
  <TextInput placeholder="Décrivez la feature..." />
  <GeneratedPlan>
    <TaskList />
    <PredictedGitTree />
  </GeneratedPlan>
  <ValidationActions />
</PlanCreator>
```

### 6. ImplementMode - Exécution de Tâches
```tsx
// Responsabilités:
// - Exécution séquentielle des tâches
// - Questions IA réponses
// - Affichage des diffs
// - Approbation/Réjet des modifications

// Structure:
<TaskExecutor>
  <TaskList>
    <TaskExecution>
      <TaskInfo />
      <AIQuestions />
      <DiffViewer />
      <ApproveRejectActions />
    </TaskExecution>
  </TaskList>
</TaskExecutor>
```

---

## État Global (Zustand)

### useAppStore
```typescript
{
  mode: 'architect' | 'implement',
  currentPlan: Plan | null,
  activeTasks: Task[],
  selectedProjects: Project[]
}
```

### useProjectStore
```typescript
{
  projects: Project[],
  projectGroups: ProjectGroup[],
  activeProjectId: string | null
}
```

### useChatStore
```typescript
{
  messages: Message[],
  currentTask: Task | null,
  awaitingResponse: boolean
}
```

### useEditorStore
```typescript
{
  currentFile: File | null,
  fileContent: string,
  readOnly: true
}
```

---

## Implémentation Phase par Phase

### Phase 1.1: UI Foundation
- [ ] Initialiser TailwindCSS
- [ ] Installer Shadcn/ui
- [ ] Créer AppLayout avec 3 panneaux
- [ ] Style de base responsive

### Phase 1.2: CodeMirror 6
- [ ] Intégrer CodeMirror 6
- [ ] Extensions: TypeScript, Rust highlighting
- [ ] Mode read-only par défaut
- [ ] Decorations git (lignes ajoutées/modifiées)

### Phase 1.3: State Management
- [ ] Configurer Zustand stores
- [ ] Configurer Jotai atoms
- [ ] Créer hooks personnalisés

### Phase 1.4: Left Panel
- [ ] Composant ProjectGroup
- [ ] Composant ProjectItem
- [ ] Métadonnées projet affichage
- [ ] États actif/inactif

### Phase 1.5: Chat Zone
- [ ] Composant TaskList
- [ ] Composant TaskItem
- [ ] Interface de chat basique
- [ ] CodeEditor read-only intégré

### Phase 1.6: Right Panel
- [ ] Composant GitTree
- [ ] Composant GitTreeTab
- [ ] Visualisation arbre git prédit
- [ ] Statistiques modifications

### Phase 2: Modes Architecte & Implémentation
- [ ] Mode Architecte complet
- [ ] Mode Implémentation complet
- [ ] Diff viewer popup
- [ ] Approbation/Réjet workflow

---

## Diagramme de Flux de Données

```
┌─────────────────────────────────────────────────────────────────────┐
│ Flux de Données Frontend                                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│ User Input ───► AppStore (Zustand) ───► Tauri Commands (Rust)        │
│                   │                         ▲                       │
│                   ▼                         │                       │
│ Component State ──┼───► UI Update ────────────┼───► Display         │
│                   │                         │                       │
│                   └───────────► API Calls ────┘                       │
│                                 │                                    │
│                                 ▼                                    │
│                           Backend Response                           │
│                                 │                                    │
│                                 ▼                                    │
│                       Update AppStore ──► UI Re-render              │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Responsive Design

### Desktop (> 1200px)
- 3 panneaux visibles simultanément
- Panneaux gauche/droite: 280px
- Zone chat: flexible

### Tablet (768px - 1200px)
- Toggle panneaux gauche/droite
- Zone chat toujours visible
- Onglets pour basculer entre panneaux

### Mobile (< 768px)
- Navigation par drawer pour projets
- Chat en plein écran
- Diff viewer modal
- Éditeur read-only en mode plein écran (optionnel)
