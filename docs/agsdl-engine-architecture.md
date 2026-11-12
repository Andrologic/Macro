# Contrats du moteur AgSDL

Le moteur courant exécute [AgSDL 0.3](agsdl-030.md). Le compilateur, les
contrôleurs de travail et de routes restent purs ; les ports natifs portent la
capture, l’admission et les effets. Le superviseur conserve les preuves,
les autorités et les garanties d’arrêt existantes. Le navigateur ne crée aucune
autorité depuis un champ de diagnostic ou une déclaration du document.

Les contrats sont dans `contracts030.ts`, les valeurs exactes dans `exact.ts`
et les DTO partagés dans le registre IPC natif. Les modules `flow030`,
`flow_work_protocol030` et `start030` conservent le journal natif. Les pièces
communes du protocole de travail sont dans `work_dto030.rs` ; elles n’ajoutent
aucune dépendance moteur à Tauri ni à une base Macro.

L’exécution 0.2 et ses 22 tables obsolètes sont retirées par la migration 042.
L’historique de migration reste disponible pour vérifier les sauvegardes.
Les domaines Macro extérieurs à ce moteur restent indépendants.

Voir [les modules d’exécution](../src/services/agsdlExecution/README.md),
[la conformité](../dev/agsdl/README.md) et [la qualification Codex](agsdl-codex-native.md).
