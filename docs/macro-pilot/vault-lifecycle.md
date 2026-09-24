# Cycle de vie du coffre desktop Pilot

Ce contrat complète le [transport natif](native-transport.md) pour les accès
aux credentials et l'action de reprise de l'interface desktop.

## Contrat de l'interface

`usePilotStore.resumeVaultAccess()` est une action explicite de l'utilisateur.
L'interface peut la proposer lorsque `vaultStatus` vaut
`intervention_required`, `cancelled`, `suspended` ou `vault_unavailable`.
Un montage, un réveil, un polling ou un rafraîchissement ne doit pas l'appeler.
La reprise vérifie le verrouillage du trousseau macOS et peut demander son
déverrouillage avant les lectures ciblées. Elle ne préautorise pas une ACL
d'écriture : une écriture ultérieure peut encore être refusée.
Une seule reprise peut être en cours. La déconnexion peut l'interrompre
logiquement ; le résultat natif tardif ne rétablit pas la session.

L'état de connexion reste `vault_unavailable` pendant un blocage du coffre.
Le champ `vaultStatus` distingue la raison contrôlée :

| État natif | Erreur du client | Interprétation |
| --- | --- | --- |
| `intervention_required` | `vault_intervention_required` | Une intervention est nécessaire. |
| `cancelled` | `vault_cancelled` | Le système a signalé une annulation. |
| `suspended` | `vault_suspended` | Le cycle de vie a suspendu l'accès. |
| `vault_unavailable` | `vault_unavailable` | Échec de stockage, sans cause supposée. |
| `ready` | aucune | Les accès ordinaires peuvent être tentés. |

Une lecture absente renvoie `null`, jamais une erreur convertie en absence.
`context_changed` invalide un résultat périmé. Une reprise réussie restaure
la session existante et peut relire le catalogue. Elle ne rejoue aucune
mutation réseau, connexion, confirmation de compte ou création d'instance.
Après déconnexion, la reprise utilise une référence neuve et absente pour
déverrouiller le coffre, sans relire les credentials à supprimer.

## Propriété et invalidation

Le gestionnaire Rust possède le cache mémoire et la génération opaque.
Les commandes de lecture, écriture, suppression et reprise exigent cette
génération. L'activation porte la configuration, l'origine HTTPS et le
propriétaire courant. Un changement de propriétaire exige la génération
courante et vide le cache. Un refus reste bloquant après ce changement.

Les lectures simultanées partagent les valeurs et les absences en cache,
limité à huit scopes.
Une écriture n'alimente le cache qu'après persistance native réussie.
La déconnexion, la révocation locale, le changement de contexte, la fermeture
et, sur macOS, les notifications de veille ou de verrouillage invalident
les credentials en mémoire. Une opération déjà engagée vérifie à nouveau sa
génération avant de rendre son résultat. L'invalidation n'attend pas son I/O.

Un dialogue système déjà ouvert par l'action explicite peut rester visible
après une déconnexion. Son résultat ne peut plus alimenter le cache ni lancer
la suite du lot. Réveil et déverrouillage ne réarment pas le coffre.

## Nettoyage et durabilité

La session devient restaurable seulement après écriture durable de son jeton.
Si l'enregistrement du nettoyage de la tentative échoue ensuite, la session
reste utilisable et la tentative conservée permet de réessayer ce nettoyage.
La déconnexion enregistre une session vide et les références de nettoyage
dans la même mise à jour de métadonnées, avant la suppression physique.
Ces références sont des tombstones : une ancienne session qui les mentionne
ne peut pas être restaurée. Elles ne contiennent aucun secret.

Le nettoyage est différé, ciblé et sans lecture préalable du secret sur macOS.
Son échec conserve les références pour une tentative ultérieure. Il ne bloque
ni la fin de la déconnexion ni la restauration initiale. Aucune boucle ne
réessaie après un refus. Un échec d'écriture des métadonnées reste une erreur,
la déconnexion durable n'est alors pas annoncée comme réussie.

## Garanties macOS et isolation

Le backend macOS utilise les API historiques Keychain Services. Un verrou
sérialise les accès Pilot et la politique d'interaction du processus.
Les accès ordinaires interdisent l'interaction puis restaurent exactement
la politique antérieure. Une restauration de politique en échec bloque
les accès suivants dans le processus. Les erreurs OSStatus inconnues restent
des erreurs de stockage. Les journaux ne contiennent que l'opération, le type
de secret, la durée, l'OSStatus et une corrélation opaque.

Cette politique évite l'attente d'un consentement utilisateur pendant un accès
ordinaire. Elle ne fixe pas de délai absolu à un service système défaillant.
Les notifications de veille et de session complètent la notification distribuée
de verrouillage macOS, dont le nom n'est pas une API publique documentée.

L'identité native `com.macro.desktop` conserve le service historique
`ai.andrologic.macro.pilot.v1`. Les autres identités d'application utilisent
`macro.pilot.v1.app:{identifier}` sans fallback vers la production.
L'IPC ne permet pas de choisir ce namespace. Les configurations de test doivent
utiliser une identité native distincte.

Windows et Linux conservent leur backend de credentials existant. La garantie
sur la politique globale d'interaction décrite ici concerne macOS uniquement.
