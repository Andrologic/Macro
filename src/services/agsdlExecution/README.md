# Exécution AgSDL 0.3

Le profil `macro-agsdl-030-v1` utilise le compilateur pur `compiler030.ts`,
les contrôleurs de travail et de routes TypeScript et le superviseur natif.
Les ports existants séparent ces contrôleurs de Tauri, des fenêtres et de la
base Macro. Le journal natif conserve les admissions, captures, identités,
effets, attentes humaines et preuves de fin physique. Les observations et la
qualification des harnesses restent distinctes de la validité du document.

`exact.ts` réutilise les helpers lexicaux partagés du lecteur : une seule classe
`NumberToken`, des lexèmes JSON conservés et des comparaisons décimales exactes.
`sourceDigest.ts` et `assembleVisibleText` restent partagés avec les tâches Macro
et les transports. Aucun remplacement des valeurs 0.2 par des valeurs 0.3 n’est
implicite.

L’édition 0.2 ne possède plus de lecteur produit, de compilateur, de scheduler,
d’adaptateur ou de persistance d’exécution. Son ouverture affiche une édition
non supportée. Aucune conversion de document ni exécution de repli n’est proposée.
Les types encore nécessaires à la lecture de captures déjà incorporées aux
transcriptions n’autorisent aucune résolution native ni exécution ancienne.

La migration 042 retire les 22 tables d’exécution obsolètes, garde les tables
`engine_flow030_*`, `engine_start030_requests`, `engine_start030_entries` et les
intentions 0.3. Les migrations historiques restent identifiées pour la validation
des sauvegardes ; les autres domaines Macro sont conservés.

Les 37 scénarios officiels passent par le superviseur de production avec des
exécuteurs scriptés et des captures synthétiques : N33/M4/K0. Les quatre M
restent des refus produit précis, sans qualification implicite. Voir
[la conformité](../../../dev/agsdl/README.md),
[le profil 0.3](../../../docs/agsdl-030.md) et
[le profil Codex](../../../docs/agsdl-codex-native.md).
