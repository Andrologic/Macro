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

Les fichiers, fixtures, documents et commits de Macro doivent pouvoir être
publics. Sa compilation et ses tests ne doivent pas nécessiter l'accès aux
dépôts privés. Les fixtures utilisent des données de test synthétiques.
Les secrets OAuth serveur, jetons d'exploitation, identifiants de production
et configurations confidentielles restent dans la configuration serveur hors
Git. Aucun secret serveur n'est embarqué dans desktop ou mobile.

Le serveur vérifie l'identité, la session et les droits sur chaque instance,
quel que soit le client. La ressemblance avec le client officiel ne constitue
pas une autorisation.

## Fonctionnement interface desktop fermée

Le maintien de l'exécution lorsque l'interface desktop est fermée reste à
préciser. Le choix d'une exécution desktop ne définit pas à lui seul le cycle
de vie du service ni sa reprise.

## Conservation par la passerelle

La passerelle assure le relais. Sa rétention technique, notamment la durée et
les données conservées pour la reprise, reste à préciser.

Le contrat définit curseurs et reprise sans fixer leur durée. Il ne contient
aucun objet conversation, contenu de fichier ou chemin machine. La politique de
rétention sera ajoutée seulement après décision.

## Providers de la première version

Décision attendue : quels providers le moteur autonome doit-il prendre en
charge au lancement ?

Le contrat de supervision ne nomme aucun provider et n'accepte aucun secret de
provider. Leur configuration appartient au runtime, hors de ce lot.

## Effet d'une validation Git mobile

Décision attendue : une approbation mobile enregistre-t-elle seulement un
verdict, autorise-t-elle un merge local, ou autorise-t-elle aussi une action
distante ?

`review.submit` enregistre uniquement `approve` ou `request_changes` pour une
review liée à deux SHA. Aucun merge, push ou changement de branche ne découle
du contrat `1.0`.
