# Macro — Plan d’implémentation UI/UX (frontend) + backend simulé

> Objectif : livrer une UI/UX complète et cohérente **sans backend réel**, en simulant toutes les fonctionnalités côté frontend. La couche de données doit être **facilement remplaçable** par le backend Tauri (IPC) par la suite.

## 1) Principes directeurs
- **Local-first** : tout fonctionne offline avec données simulées.
- **UI read-only** : l’utilisateur valide, l’IA construit.
- **Workflows visibles** : chaque mode affiche ses outils, tâches, états.
- **Séparation nette** : UI ↔️ services ↔️ providers (mock vs IPC).
- **Remplaçable** : toutes les données passent par des contrats typés.

---

## 2) Architecture frontend cible

```
src/
  components/
    layout/     (Header, Footer, Panels, StatusBar)
    chat/       (ChatZone, Thread, Input, Actions)
    tasks/      (UnifiedTaskList, TaskDetail, TaskFilters)
    git/        (Graph, Tree, Legend)
    editor/     (ReadOnlyEditor, DiffViewer, FilePreview)
    modals/     (Confirm, Settings, DiffModal)
    shared/     (Buttons, Tabs, Badges, EmptyStates)
  services/
    index.ts
    providers/
      mock.ts
      ipc.ts
    contracts/
      dtos.ts
      errors.ts
  stores/
    useAppStore.ts
    useChatStore.ts
    useTaskStore.ts
    useGitStore.ts
    useEditorStore.ts
  mocks/
    plans.ts
    tasks.ts
    git.ts
    chat.ts
  types/
    index.ts
```

---

## 3) Simulation backend (frontend-only)
### But
Simuler les comportements du backend :
- File system
- Git
- Plans / tâches
- Indexation
- IA

### Stratégie
1. **Contrats stricts** (`services/contracts/*.ts`) :
   - `PlanDto`, `TaskDto`, `FileDiffDto`, `GitCommitDto`, `ChatMessageDto`.
2. **Provider mock** (`services/providers/mock.ts`) :
   - Données stockées en mémoire + localStorage
   - Latence simulée (`setTimeout`)
   - Erreurs simulées (pour UX erreurs)
3. **Provider IPC** (`services/providers/ipc.ts`) :
   - Stubs qui appellent `invoke()` Tauri plus tard
4. **Switcher de provider** via config globale (`services/index.ts`).

### Exemple de couche service (pattern)
- `ChatService.listThreads()`
- `TaskService.listByProject(projectId)`
- `GitService.getGraph(projectId)`

---

## 4) UI/UX globale (layout & navigation)
### 4.1 Header
- Logo + nom
- Sélecteur de mode (Architect / Implement)
- Actions : settings, connexion, help

### 4.2 Left Panel (projets)
- Groupes collapsibles
- Recherche + filtres
- Indicateurs de statut (indexation, git, erreurs)
- Boutons : créer groupe / ajouter projet / importer repo

### 4.3 Center (chat + tâches unifiées)
- Chat toujours visible
- Tâches unifiées (multi-projet) en haut
- Vue “Plan en cours” (Architect)
- Vue “Exécution de tâche” (Implement)

### 4.4 Right Panel (Git)
- Onglets par projet
- Vue Git Tree + Graph
- Statuts de tâches reliés aux commits

### 4.5 Footer / Status bar
- Statut IA (online/offline)
- CPU / RAM simulés
- Version app
- Raccourcis clavier

---

## 5) Modes & workflows
### 5.1 Mode Architect
- Entrée intention (textarea + prompt chips)
- Génération plan (simulé)
- Vue plan : liste de tâches + dépendances
- Validation : “Accepter le plan” / “Modifier”

### 5.2 Mode Implement
- Sélection tâche
- Questionnaire IA simulé (chips boutons)
- “Préparation du diff”
- Revue diff par fichier
- Appliquer / Rejeter

---

## 6) Vue Editor (Read-only)
- Panneau central ou modal
- CodeMirror en lecture seule
- Highlight des diffs
- Navigation fichier + symboles

---

## 7) Diff Viewer & Modales
- Diff par fichier, groupé par tâche
- Indicateur de risque (high/med/low)
- Boutons Accept/Reject globaux
- Modal confirmations

---

## 8) UX d’erreurs et états
- Empty states riches (illustrations + CTA)
- Loading skeletons partout
- Messages d’erreurs détaillés
- Retry actions

---

## 9) Design System & tokens
- Harmoniser tokens Tailwind
- Créer styles : `bg-elevated`, `text-muted`, `border-weak`
- Composants réutilisables : `Badge`, `Tabs`, `SegmentedControl`, `Card`.

---

## 10) Phases de livraison
### Phase 1 — Fondations
- Structure de dossiers
- Providers mock + contrats
- Stores séparés par domaine

### Phase 2 — UX principale
- Layout complet
- Chat + tâches unifiées
- Header + Footer

### Phase 3 — Workflow complet
- Mode Architect
- Mode Implement
- Diff viewer + read-only editor

### Phase 4 — Polish
- Empty states
- Animations
- Responsive
- Micro-interactions

---

## 11) Checklist d’acceptation
- [ ] Layout 3 panneaux complet
- [ ] Chat fonctionnel (simulé)
- [ ] Task list unifiée multi-projets
- [ ] Git graphs par projet
- [ ] Mode Architect / Implement complet
- [ ] Diff viewer + read-only editor
- [ ] Services mock + contracts stricts
- [ ] Provider IPC prêt à brancher

---

## 12) Tâches frontend détaillées (exhaustif)
### Data layer
- [ ] Définir DTOs pour toutes les entités
- [ ] Implémenter mocks + latence
- [ ] Ajouter simulateur d’erreurs (ex: 10% fail)
- [ ] Persistance locale (localStorage)

### UI Layout
- [ ] Header actions & status
- [ ] Left panel avec recherche
- [ ] Center avec chat + tasks
- [ ] Right panel avec onglets projets
- [ ] Footer status bar

### Chat & Tasks
- [ ] Threads + unread
- [ ] Input actif + suggestions
- [ ] Liste de tâches unifiée
- [ ] Détail tâche (dep, état)

### Git
- [ ] Tree view stable
- [ ] Graph view responsive
- [ ] Legend et filtres

### Editor
- [ ] Read-only CodeMirror
- [ ] Diff modal
- [ ] File preview inline

---

## 13) Préparation future backend (IPC)
- `services/providers/ipc.ts` expose mêmes signatures que `mock.ts`.
- Aucun composant UI n’appelle directement Tauri.
- Changement = switch provider unique dans `services/index.ts`.

---

## 14) KPI UX (simulés)
- Temps de génération plan < 2s (mock)
- Latence chat < 400ms (mock)
- Diff visible instantanément
- Tâches ≤ 1 clic depuis plan

---

## 15) Conclusion
Ce plan permet un **frontend complet**, réaliste et testable **sans backend**, avec une transition future vers IPC **sans refonte UI**. Chaque fonctionnalité UI est prévue dès maintenant avec des données simulées et des contrats solides.
