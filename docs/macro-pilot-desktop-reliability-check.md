# Recette synthétique de fiabilité desktop Pilot

La recette du 12 octobre 2026 part du commit `c2e6be03113505547199ab79edf68f2287d59f6b`, dans une branche feature dédiée. Elle utilise les ports simulés du runtime/client, des stores synthétiques, des bases SQLite jetables et un test DOM du composeur. Aucun provider réel, trousseau, OAuth, application installée ou réseau réel n'est nécessaire.

## Résultats

Aucun défaut de production n'a été reproduit dans ce périmètre. La seule modification ajoute un test de garde dans `runtimeContent.test.ts` pour l'observation sans lecture distante, l'arrêt et la reprise. Les contrats canoniques et les producteurs restent inchangés.

| Cas | Preuve et résultat |
| --- | --- |
| Producteurs sans demande | Pendant quatre appels de métadonnées supplémentaires, zéro appel aux métriques, logos, réflexions ou fichiers, zéro transcript, résultat distant ou événement de changement. |
| Arrêt et reprise | Après stop, aucun appel natif ni requête transport supplémentaire pendant 1,1 seconde. La reprise refait le poll sans lire les producteurs coûteux ni les transcripts. |
| Chats indépendants | Avec network-reliability-1, une modification de A conserve le curseur de B et émet une invalidation de ressource pour A. Suppression, changement de portée, politique et expiration restent refusés aux bonnes frontières. |
| ACK perdu | Les tests de runtime rejouent le résultat ou l'événement identique. Une autorisation révoquée empêche la réémission. Les effets durables ne sont pas déclenchés deux fois. |
| Envoi incertain et status | Les reçus SQLite, marqueurs launch_uncertain, pertes d'ACK et reprises après arrêt conservent l'identité de l'envoi. Un lancement incertain n'est pas relancé automatiquement. |
| Brouillons | Les références explicites d'un envoi distant ne demandent pas d'effacement du composeur. Le test DOM conserve puis restaure texte, images et références quand le chat sélectionné change. |
| Erreurs fournisseur | Le diagnostic neutre est projeté dans le catalogue, avec catégories et conseils fixes. Les textes privés du provider restent retenus dans les captures. |
| Réflexions et fichiers | Les gardes de portée, propriétaire, expiration, politique et autorisation finale passent. Les queries minimales de réflexions fonctionnent sans colonnes provider ; les fichiers associés persistent après retrait de l'autorité d'upload. |

L'observateur de métadonnées reste actif pour produire les notifications même sans lecture distante. Il ne collecte pas les ressources coûteuses à leur place. Les transcripts déjà livrés sont observés jusqu'à expiration de leur capture ou clear de lifecycle, afin de détecter les modifications et les inserts antidatés. Après expiration ou clear, leur observation s'arrête. La fermeture d'un lecteur mobile n'est pas transmise au desktop par un message du contrat actuel ; cette recette ne prétend pas prouver un arrêt instantané à la fermeture d'un bloc mobile. Ajouter une telle présence ou libération exige une décision coordonnée de contrat.

## Mesures du harness existant

Le scénario modifie A après lecture de A et B, reprend le curseur de B et relit conditionnellement les projets. Deux modes sont comparés sur les mêmes données synthétiques.

| Mesure | Legacy | network-reliability-1 |
| --- | ---: | ---: |
| Échanges logiques | 3 | 2 |
| Événements producteur | 3 | 2 |
| Lectures source de transcript | 8 | 6 |
| Relectures de transcript | 1 | 0 |
| Réinitialisations de capture | 1 | 0 |
| Octets JSON | 47 575 | 2 084 |
| Somme des corps gzip | 3 403 | 1 314 |

Ces volumes décrivent les corps du harness, sans en-têtes, TLS ni compression réelle du transport. Les temps d'exécution ne servent pas de seuil matériel. Le bénéfice vient de l'invalidation ciblée et de la réponse conditionnelle déjà présentes ; aucune nouvelle optimisation de production n'est attribuée à cette recette.

## Vérifications et limites

Les suites ciblées totalisent 282 tests Bun réussis, avec un test de captures Git natives ignoré. Le test DOM sélectionné filtre volontairement les autres cas de son fichier. Les commandes TypeScript et le lint du fichier ajouté passent.

Les treize tests du lecteur minimal exécutent les queries natives sur SQLite synthétique. Trois tests SQLx de réflexions et dix-huit tests SQLx de fichiers passent en réutilisant le binaire de tests déjà compilé. Son SHA-256 a été contrôlé et les sources Rust sont identiques entre sa base `dd86e1c8` et la base de cette recette. Ce sont de nouvelles exécutions du binaire conservé, pas une nouvelle compilation. Les contrôles de fichiers couvrent notamment reçus atomiques, marqueurs, révocation, reprise, quotas et expiration.

La recette ne mesure pas RSS, CPU, réseau réel, rendu WebView, comportement réel des providers ou appareils mobiles. Elle ne valide pas un build nouveau ni une application lancée. Les journaux, empreintes et l'audit indépendant sont livrés hors Git. L'intégration et le registre du chantier restent à la racine.
