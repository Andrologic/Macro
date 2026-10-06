# Conformité et compilation AgSDL inline

Ces modules préparent le profil `macro-serial-inline-v1`. Ils ne démarrent aucun
travail. `PRODUCT_RUNTIME_AVAILABLE` et `CompilationResult.productRuntimeAvailable`
restent `false` tant que les lots host et flow ne sont pas intégrés.

## Versions et représentation

- Contrat normatif `agsdl-0.2.0`, publication
  `ae478d6203dd1571af064317238fd0a0f7dece75`.
- Compilateur `macro-agsdl-inline-compiler/1`.
- Contrôles locaux `macro-agsdl-conformance/1`.
- Plan `macro-agsdl-compiled-plan/1`.
- Publication `macro-agsdl-publication/1`.

`decode` vérifie aussi le champ d'erreur du scanner vendor. `encode`, `equal`,
`shape`, `satisfies` et `NumberToken` conservent les nombres exacts. Les valeurs
AgSDL ne passent ni par `JSON.parse` ni par `structuredClone`. Les JSON ordinaires
utilisés pour comparer les schémas du registre Macro et les descriptors MCP
proviennent des contrats typés existants, jamais des valeurs authored.

`CompiledPlan` conserve le document exact, ses déclarations et settings, les
adresses tableaux, les routes normales et d'erreur, les tokens `maxVisits` et les
configurations développées. `compiledPlanJson` est le transport durable proposé.
Les JSON de ses champs restent des chaînes exactes. Le propriétaire natif doit
valider ce format et ses versions avant d'appliquer son autorité de routage.
Un `maxVisitsJson` reste un entier mathématique JSON, par exemple `1e20`.
Le natif le convertit sans perte en compteur décimal canonique.

## Raccord du futur host

1. Le natif lit la source canonique du plan, contrôle son propriétaire et sa
   révision, puis fournit `SourceRevision` et un `CapturedRegistry` authentifié
   au host résident. La révision actuelle est celle du fichier metadata du plan,
   pas une révision interne AgSDL. Aucun helper local ne prouve le propriétaire
   ni la fraîcheur du fichier.
2. `compilePlan` valide le document vendor, revérifie le SHA-256 des octets UTF-8,
   contrôle le profil et toutes les configurations Agents, puis renvoie séparément
   `static` et `runtime`. Un refus produit un diagnostic structuré et aucun plan.
3. Avant une livraison, `validateOrigin` puis `deliveryMessage` et `validateInput`
   contrôlent la frontière. `prepareMessage` applique seulement les sélecteurs de
   l'entrée courante. `conditionResult` conserve la même valeur et son origine.
4. Avant un Call, `prepareCall` vérifie le binding, l'origine, les arguments exacts,
   leur schéma et le scope évalué. Le host effectue ensuite les contrôles Macro
   réels, enregistre l'effet dans le repository natif et réutilise le dispatch.
   `validateRegisteredResult` ou `callResult` contrôlent le `data` retourné.
5. Pour un Agent, l'adaptateur réutilise `streamingChat` et `toolCallingLoop`.
   Il fournit uniquement les Messages visibles complets de l'activation aux
   méthodes `append` et `publish` de `ExactResponseCollection`. Il exclut lui-même
   reasoning, échanges bruts d'outils et historique. Le collecteur ne prétend pas
   déduire ces catégories de chaînes arbitraires.
6. La collection doit fermer avant le commit terminal. `validateCompletion`,
   `completionResult` et `selectedRoute` contrôlent les sorties requises et le
   choix avant une continuation. Le natif conserve la terminaison, la mémoire,
   le curseur et les livraisons dans une transaction unique.

`toDispatchValue` est une conversion facultative pour les DTO ordinaires du
registre Macro actuel. Elle exige que chaque nombre converti ait exactement la
même valeur décimale JSON après aller-retour. Elle refuse dépassement, perte de
précision et arrondi avant un effet. Elle ne remplace pas le stockage exact.

## Registre capturé et limites de confiance

`CapturedRegistry` est une entrée de l'adaptateur de confiance du démarrage natif.
Ce module pur ne constitue pas un service d'authentification. Une construction
frontend du même objet ne donne aucun droit d'exécuter un effet. Aucun champ
`supported` ni claim authored ne produit une attestation.

Chaque `BindingAttestation` correspond par égalité JSON exacte à la déclaration
complète, donc aux éditions contract et implementation, settings, effects et
requirements. Les capacités vérifiées du chemin et les requirements complets
sont des observations de l'autorité future. Des paramètres absents diffèrent
bien de `{}`. Aucun ordre de versions, sous-ensemble ou claim d'un Tool ne prouve
la configuration Agent entière.

Le binding sélectionne explicitement un adaptateur Macro, un identifiant Tool
présent dans `MACRO_TOOL_REGISTRY`, ou un couple serveur/Tool MCP et son descriptor
capturé. Les arguments des Tools Macro doivent conserver leur schéma réel.
Les descriptors MCP doivent provenir de la découverte typée Macro. Leur schéma
de résultat et leurs contrôles d'accès restent des attestations de l'adaptateur,
car le DTO `MCPTool` actuel ne fournit pas ce contrat de sortie. Une absence de
preuve bloque le chemin.

Le catalogue Model capturé doit fournir une édition explicite, un provider et
un modèle uniques. `ConfigurationAttestation` doit correspondre à l'Agent et à
sa configuration authored et couvrir les requirements de configuration et des
skills. Les settings effectifs, permissions et scope sont capturés sans secrets.
Les vérifications de droits actuels et les approbations Macro restent nécessaires
à chaque invocation réelle.

Le validateur d'arguments couvre le sous-ensemble effectivement utilisé ici,
`type`, `properties`, `required`, `additionalProperties`, `items`, `enum`,
`minLength`, `allowEmpty` et `description`. Tout autre keyword MCP bloque le
préflight. Les résultats utilisent le langage fermé `valueSchema` AgSDL, vérifié
avec les règles vendor. Aucun validateur JSON Schema général n'est annoncé.

## Protocole de publication

Le plan contient `publicationContractJson` par step Agent et
`graphlessPublicationContracts` pour les sorties nommées sans graphe. Le contrat
explicite contient le protocole/version, la version du registre, l'Agent,
l'adresse ou `null`, l'Interface complète, les choix et le binding de décision.
Ce contrat est injectable dans le futur adaptateur. Il exige une capacité
`typed-publication` vérifiée du chemin Engine et un binding de décision explicite
lorsque le step décide.

L'adaptateur reçoit ce contrat lors de la configuration de son canal de
publication typé. Une publication transporte `TypedPublication` avec ce contrat
exact, son attribution au work et à une tentative fournisseur enregistrée,
son identité stable, sa séquence d'émission, `resultsJson` et un choix ou `null`.
Aucune phrase de sortie ne devient une publication. Un résultat doit être nommé
par l'Interface, respecter son format et son `valueSchema`. Le choix doit être
déclaré. Plusieurs publications peuvent compléter des résultats distincts,
mais une seconde occurrence d'un même résultat ou choix est ambiguë et refusée.

Les séquences sont canoniques, positives et communes aux Messages et publications.
Elles commencent à `1`. Les événements peuvent arriver dans le désordre, mais la
fermeture exige la continuité jusqu'au curseur inclus. `0` ferme une collection
vide. Les retransmissions identiques avant fermeture sont idempotentes. Les
conflits, trous, mauvaises attributions et émissions après fermeture échouent
avec `CORRELATION`. Une fermeture répétée au même curseur conserve le résultat.
Les bornes par défaut sont 10 000 événements et 2 000 000 octets de texte visible.
Elles bloquent une collection trop grande sans tronquer ses sorties.

Le collecteur est en mémoire. Le host et le repository devront persister l'ordre,
les événements, leur attribution et la fermeture pour prouver la reprise. Ils
devront aussi prouver les garanties d'effets et de terminaison. Aucun scheduler,
SQL, commande IPC ou host physique n'est ajouté dans ce lot.

## Vérifications

Les tests ciblés couvrent les frontières de rôles, précision numérique,
contraintes, refus du profil, bindings et collecte. Le test différentiel
`referenceConformance.test.ts` accepte `AGSDL_REFERENCE_DIR`, un checkout local
AgSDL 0.2.0. Il compare delivery, completion, préparation et expansion avec les
helpers Python publiés. Pour Condition, il applique les règles normatives avec
leurs fonctions officielles `operand_value` et `equal`, car la publication ne
fournit pas de helper Python d'exécution Condition autonome. Sans cette variable,
ce seul test différentiel est explicitement ignoré. Il n'effectue aucun réseau.

Les ports de contenu et contraintes dérivés de `sources.py`, `check_delivery.py`
et `check_completion.py` portent leur attribution Apache-2.0 en tête de module.
Le NOTICE et la licence du lecteur vendor restent conservés.
