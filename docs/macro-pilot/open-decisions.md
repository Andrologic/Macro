# Décisions ouvertes de Macro Pilot

Ce document trace les parcours exclus du contrat stable `1.0`. Les schémas et
fixtures ne leur attribuent aucun comportement implicite.

## Topologie d'exécution

Décision attendue : Macro Pilot supervise-t-il seulement un service autonome
sur la machine de l'utilisateur, ou aussi un service hébergé ?

Le contrat `1.0` décrit une `instance` sans URL, mode d'hébergement ou mécanisme
de découverte. Il fonctionne avec un service local et avec un relais, mais ne
promet aucun moteur hébergé.

## Conservation par la passerelle

Décision attendue : la passerelle conserve-t-elle conversations et code, ou
relaie-t-elle des enveloppes sans historique canonique ?

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
