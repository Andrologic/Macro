# AgSDL 0.2.0 dans Macro

Les nouveaux systèmes Architect utilisent le contrat publié `agsdl-0.2.0`.
Le lecteur provient du tag `v0.2.0`, commit
`ae478d6203dd1571af064317238fd0a0f7dece75`. Sa licence Apache-2.0,
sa provenance et ses adaptations navigateur figurent dans
[`src/vendor/agsdl/NOTICE.md`](../src/vendor/agsdl/NOTICE.md).

## Déclarations et lecture

Un document déclare des catalogues nommés d’agents persistants, de configurations
et de bindings. Les sources de contenu séparent les instructions du prompt et
les ressources d’information. Les skills précèdent le prompt propre à l’agent
dans l’ordre déclaré. Une configuration nomme explicitement son moteur et ses
outils. Les éditions externes et leurs exigences restent des déclarations ;
leur présence ne prouve pas leur prise en charge par Macro.

Le visualisateur lit les agents sans graphe ainsi que les étapes `agent`, `call`,
`condition`, `prepare`, `join`, `approval` et `compose` d’un flow. Les utilisations
répétées d’un agent désignent le même participant persistant. Les routes décrivent
les activations prévues ; les fiches distinguent les instructions, les ressources
et les données transmises. Les compositions conservent les liens vers leurs
déclarations. Une référence absente reste signalée sans fabriquer de destinataire.

Les outils du chat renvoient un guide correspondant à l’édition du document.
Les modifications atomiques utilisent les pointeurs JSON et la révision du plan.
Le sélecteur de fournisseur et modèle configure les déclarations du moteur Macro
lorsqu’une configuration fixe et compatible peut être identifiée. Une configuration
partagée concerne tous les agents qui la référencent. Un choix explicite écrit
atomiquement l’Edition `macro/native-model/p/<provider>/m/<model>` en version `1`
et les deux paramètres `providerId` et `modelId`. Les segments sont les identités
UTF-8 encodées en base64url canonique sans padding. Une Edition Macro native
existante reste modifiable si ses paramètres présents concordent exactement ;
les Editions étrangères ou incohérentes restent préservées. Modifier seulement
le prompt n’ajoute pas de modèle et cette convention ne prouve pas la disponibilité
d’un transport d’exécution. Une édition de configuration
rend ses anciennes assertions de support caduques ; elles doivent être réévaluées.

## Lecture paginée dans le chat

`agsdl_get` borne chaque réponse JSON complète à 40 Kio en UTF-8, sous le seuil
de débordement du transport de 50 Kio. La lecture initiale fournit la révision,
le guide de l’édition et un inventaire compact de noms et de pointeurs, sans
copie des déclarations. Les clés de catalogue historiques restent présentes ;
`outline.entries` est la liste ordonnée de la page courante.

Pour découvrir tout le document, rappeler `agsdl_get` avec `section: "outline"`,
`offset: outline.next_offset` et `expected_revision: revision` jusqu’à ce que
`next_offset` soit `null`. `total` compte toutes les entrées, `returned` celles de
la page. `limit` demande au plus 200 entrées ; le budget en octets peut réduire
la page. Un `path` filtre cet inventaire sur le pointeur lui-même et ses descendants,
y compris les étapes des compositions. Garder ce filtre pendant la pagination.
Les pages après la première exigent la révision ; un changement pendant la lecture
ou la validation demande de recommencer.

Une lecture individuelle avec `path` renvoie la source JSON exacte du sous-arbre
lorsqu’elle tient dans la réponse. Elle ne répète pas l’inventaire global. Un champ
`*_omitted` indique explicitement la section à lire pour récupérer un contenu trop
volumineux. Les sections `source`, `design`, `display`, `models`, `annex_ids` et
`error` donnent accès à ces données. Une entrée d’inventaire exceptionnellement
longue utilise `entry_omitted` ; lire `section: "outline_entry"` avec son
`entry_index` pour récupérer son nom et son pointeur complets.

Ces sections renvoient `text_page.content`, du texte JSON paginé sans perte.
`offset` et `limit` portent alors sur les octets UTF-8, avec au plus 16 Kio demandés.
Suivre `text_page.next_offset`, conserver la même révision et concaténer les contenus
avant de parser le JSON reconstitué. `total_bytes` et `returned_bytes` décrivent
les octets du texte d’origine. Les frontières respectent les caractères UTF-8 ;
la réponse peut réduire la page pour tenir compte de l’échappement JSON.
Les pages proposent aussi `next_cursor`, lié au contenu, à la cible et à sa révision.
On peut fournir ce `cursor` à la place d’`offset`. Pour continuer la section `models`,
utiliser obligatoirement le curseur : le catalogue fournisseur peut changer sans
modifier la révision AgSDL. Un changement invalide le curseur et demande de recommencer.

Les rapports complets restent dans la session, avec leurs jetons numériques exacts.
L’aperçu `diagnostics` indique les verdicts et comptes de findings ; un petit rapport
peut aussi conserver son champ `documentReportJson`. Pour lire un rapport complet,
utiliser `section: "report"` et `report_index`, puis reconstituer ses pages de texte.
`report_count` indique le nombre de rapports disponibles. Ce contrat de lecture
s’applique aussi à la source et aux rapports historiques 0.1, sans changer leur édition.

## Données de conception

Le schéma 0.2.0 est fermé. Les titres d’affichage, l’intention de conception,
les informations à compléter et la provenance de migration vivent dans l’enveloppe
`ArchitectPlanRecord.agsdl`, aux côtés de `source`, `annexes` et `revision`.
Ils ne deviennent pas des champs supplémentaires dans le document AgSDL.
Les copies de blueprints et l’historique du brouillon conservent cette enveloppe.
Un export de source conserve le document brut. Un export de l’enveloppe conserve
aussi les informations de conception propres à Macro.

## Compatibilité et limites

Les documents `agsdl-0.1.0` restent lus et modifiables avec leur lecteur historique.
Le chargement ne change pas leur édition et les annexes restent conservées.
La migration vers 0.2.0 demande une nouvelle rédaction avec un inventaire explicite
des éléments conservés, transformés ou non représentables. Changer uniquement
le marqueur du contrat ne réalise pas cette migration. Les candidats expérimentaux
et les éditions inconnues ne reçoivent pas de sémantique implicite.

Le rapport officiel distingue la validité du document, les références déclarées,
la résolution des URI et les assertions de support. Macro conserve aussi le JSON
original du rapport sans perte des jetons numériques. Les URI relatives utilisent
uniquement la base explicitement déclarée. Le lecteur ne récupère aucune ressource
et ne vérifie pas les preuves externes.

`executionSupport` reste `not-assessed`. Cette adaptation met à jour le lecteur,
la conception et la visualisation. Elle n’introduit pas de moteur d’exécution
supplémentaire. Les tâches existantes utilisent toujours le moteur de Macro.
La continuité réelle des agents, l’admission des actions, les livraisons, les joins
et les résultats d’exécution nécessitent un adaptateur d’exécution séparément vérifié.

## Vérification des lecteurs

Les scripts de comparaison prennent un checkout du tag correspondant. Ils ne
modifient ni ce checkout ni les documents conservés dans Macro.

```sh
bun dev/agsdl/check-reader-parity-020.mjs <checkout-AgSDL-v0.2.0>
bun dev/agsdl/check-reader-parity.mjs <checkout-AgSDL-v0.1.0>
```

La comparaison 0.2.0 couvre les 112 cas du corpus officiel et compare les rapports
complets avec leurs nombres exacts. Elle vérifie aussi l’adaptation IPv6 du
navigateur. Cette conformité statique ne constitue pas un test d’exécution.
