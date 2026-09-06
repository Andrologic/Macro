# Décisions de périmètre de Macro Pilot

Ce document distingue les décisions acquises des arbitrages encore ouverts.
Le contrat `1.0` ne promet pas les comportements qui restent à préciser.

## Architecture confirmée

L'exécution se déroule dans Macro desktop. Le serveur du site assure l'identité,
les sessions, les autorisations et le relais entre desktop et mobile. Aucun
moteur hébergé par la passerelle n'est requis dans ce périmètre.

La connexion est initiée uniquement depuis Macro desktop ou Macro Pilot mobile.
Le site public ne propose aucun espace compte ni parcours de connexion
utilisateur. L'authentification du relais concerne le pilotage distant ;
l'utilisation locale de Macro reste possible sans compte.

## Frontière publique et privée

Macro est open source. Il contient le moteur local, le client de connexion et
le contrat public nécessaire à l'interopérabilité. Les implémentations serveur
de l'identité, des sessions, des autorisations et du relais restent dans le
dépôt privé du site. L'application Flutter et son client restent dans le dépôt
privé mobile. Le partage du contrat ne transfère pas ces implémentations dans
Macro et ne change ni la visibilité ni la licence des dépôts.

Macro conserve sa [licence GNU AGPL v3](../../LICENSE). La visibilité privée
d'un dépôt n'est pas une exemption de licence. Toute copie de contrats ou de
fixtures de Macro dans les dépôts privés doit prendre en compte cette licence
avant distribution. Ce rappel ne conclut pas à la conformité des futurs
livrables et ne crée aucune exception ; il ne bloque pas le travail local.

Les fichiers, fixtures, documents et commits de Macro doivent pouvoir être
publics. Sa compilation et ses tests ne doivent pas nécessiter l'accès aux
dépôts privés. Les fixtures utilisent des données de test synthétiques.
Les secrets OAuth serveur, jetons d'exploitation, identifiants de production
et configurations confidentielles restent dans la configuration serveur hors
Git. Aucun secret serveur n'est embarqué dans desktop ou mobile.

Le serveur vérifie l'identité, la session et les droits sur chaque instance,
quel que soit le client. La ressemblance avec le client officiel ne constitue
pas une autorisation.

## Cycle de vie et providers confirmés

Macro doit rester ouvert pour le pilotage. Sa fermeture rend l'instance
indisponible. Le raccord réutilise le moteur desktop existant et tous les
providers déjà disponibles dans Macro, avec leur configuration locale. Aucun
moteur autonome ni service continuant après fermeture n'est requis.

## Conservation par la passerelle

La passerelle assure le relais. Le [transport natif](native-transport.md) fixe
une conservation transitoire en mémoire de 60 secondes pour les échanges et
résultats, sans historique canonique de code ou de conversations. Une éventuelle
rétention durable supplémentaire reste à préciser.

Les curseurs de supervision sont gérés par Macro. Le transport prévoit leur
expiration et la reconstruction des snapshots, sans imposer au desktop une
durée de conservation de son journal.

## Effet d'une validation Git mobile

Décision attendue : une approbation mobile enregistre-t-elle seulement un
verdict, autorise-t-elle un merge local, ou autorise-t-elle aussi une action
distante ?

`review.submit` enregistre uniquement `approve` ou `request_changes` pour une
review liée à deux SHA. Aucun merge, push ou changement de branche ne découle
du contrat `1.0`.
