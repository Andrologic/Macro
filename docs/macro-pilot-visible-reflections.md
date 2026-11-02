# Réflexions visibles dans Pilot

Cette extension expérimentale concerne les conversations Chat et Implement. Le contrat portable est défini dans [conversation-reflections.md](../contracts/macro-pilot/v2/conversation-reflections.md). Relais et mobile doivent raccorder explicitement ce contrat. La recette sur appareils reste distincte des tests synthétiques.

## Source de présentation

`MarkdownRenderer.tsx` et le lecteur Pilot partagent `markdownRenderProjection.ts`. Cette projection conserve les vrais blocs thinking, leur ordre et leur état ouvert. Les traces d'outils restent des groupes distincts. Le parser garde les formes historiques du renderer, y compris les tags permissifs et les générations interrompues.

Les adapters Chat Completions et Responses insèrent uniquement les résumés qu'ils affichent dans le contenu assistant. La lecture Pilot utilise ce contenu de présentation. Elle ne charge aucun JSON provider, champ chiffré ou texte caché pour reconstruire des réflexions.

L'historique passe par `db_get_pilot_reflection_message`. Une transaction SQLite UTF-8 utilise octet_length sur les colonnes pour borner les bytes avant chargement, associe le message assistant à sa conversation durable, puis sélectionne son contenu, son turn, le scope/task de conversation et les ancrages d'outils minimaux. Elle expose seulement un booléen de présence du contexte caché. Si les deux branches de présentation questionnaire peuvent différer sans ce contexte, la projection retient la source. Les clés JSON d'ancrage dupliquées sont retenues lorsque SQLite et JSON.parse pourraient choisir des valeurs différentes.

Une source active utilise le message déjà mappé dans le store et le propriétaire courant du runtime, avec session, turn et identité assistant. Le lecteur minimal confirme aussi l'existence, le turn et la cible durables. Aucun chargement de transcript complet n'est nécessaire. Le contenu actif peut être plus récent que celui de SQLite. La fin de sa génération impose une nouvelle capture de l'historique persisté.

## Captures et contrôle d'accès

`ConversationReflections` garde uniquement des captures en RAM. Il inspecte toute la projection avant pagination, réserve le travail avant lecture et borne les représentations conservées. Les fragments émis sont des copies indépendantes du cache. Le contrat fixe les budgets, offsets UTF-8, états, TTL et règles de continuation.

`ContentHost` exclut ces textes de son journal et de son cache générique de réponses. Il invalide les captures lors d'un changement de politique ou de lifecycle. Le runtime négocie la capacité, exige supervise et compare le binding de chaque autorisation. `MacroPilotNativeClient` impose une garde avant toute émission d'une réponse de réflexion. Cette garde s'exécute aussi après la lecture des credentials et lors d'un retry.

Une capture active conserve son préfixe brut seulement si son propriétaire, son turn et ses métadonnées de présentation restent identiques. La comparaison finale intervient après autorisation et respecte une échéance fixe. Suppression, réécriture, réduction, changement de scope/task ou de propriétaire invalident le texte.

Le mobile applique la préférence désactivée et les blocs repliés par défaut. Les règles d'arrêt des lectures d'un bloc fermé figurent dans le contrat portable et doivent être vérifiées dans son propre raccord.

## Vérification locale

Les tests ciblés couvrent le renderer existant, la projection partagée, les requêtes SQL exactes sur SQLite synthétique, le runtime/client/IPC, les permissions, l'inspection de secrets avant pagination, l'Unicode et les gardes d'émission. Les tests de helpers Rust extraits et les requêtes exécutées séparément ne prouvent pas la compilation Tauri ou l'exécution du lecteur SQLx complet. La compilation native et les tests Rust intégrés du lecteur et du groupe DB ont également été exécutés localement. Les types IPC sont générés depuis les définitions Rust, puis contrôlés sans écriture. Aucun test synthétique ne vaut recette visuelle ou test sur appareils.
