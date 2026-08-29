# Matrice de sécurité de la revue et des checkpoints

Ce document fixe les invariants du chantier de récupération Git et de restauration des checkpoints directs. Les validations décrites ici doivent finir avant la première mutation du worktree, de l'index ou du dépôt interne.

## Sources de vérité

| Donnée | Source de vérité | Règle |
| --- | --- | --- |
| Identité de la tâche | `taskId` de la cible d'exécution | L'identifiant d'un checkpoint direct doit appartenir à cette tâche. |
| Identité du checkpoint | `TaskExecutionTarget.checkpointId` persisté dans les métadonnées de la tâche | Un identifiant persisté ne peut pas être remplacé par un identifiant recalculé. Les anciennes cibles sans identifiant peuvent retrouver une seule fois le checkpoint dérivé de la tâche et du projet, puis doivent persister cet identifiant. |
| Identité du projet | Chemin canonique du projet validé par `WorkspaceRoot` | Le checkpoint doit enregistrer cette identité. Un déplacement explicite peut mettre à jour le chemin de travail seulement si l'identité persistée, la tâche et le checkpoint correspondent. |
| Racine du projet | Répertoire canonique validé sous le workspace | Toute lecture ou mutation doit rester sous cette racine. Les liens symboliques, jonctions et points de réanalyse dans un parent sont refusés. |
| Racine des checkpoints | Répertoire canonique `app_data/direct-checkpoints` | La racine et chaque enfant direct doivent être de vrais répertoires gérés. Aucun lien, jonction ou enfant externe n'est accepté. |
| Révision de restauration | Registre backend lié à l'identifiant opaque du snapshot de revue | Le frontend ne peut fournir ni ajouter une révision. La validation et la restauration présentent l'identifiant du snapshot qui a préparé l'action. Le backend fige une seule instance de l'index et l'OID de `HEAD`, puis utilise cette paire pour tous les diffs, les métadonnées et la révision de la capture. Il relit ensuite la révision avant d'enregistrer le snapshot, puis vérifie la tâche, le projet, le checkpoint, chaque chemin et sa révision juste avant la mutation. Une paire absente, mélangée ou périmée annule toute l'opération. |
| Révision Git de revue | Objet demandé par libgit2 et contexte stable de l'opération | Une récupération ne peut demander que l'objet manquant connu. Elle actualise l'ODB et relance l'opération une seule fois. |

## Invariants et scénarios de panne

| Invariant | Panne reproductible | Résultat exigé | Preuve ciblée |
| --- | --- | --- | --- |
| G1. La récupération d'un objet Git est bornée. | Supprimer un commit, un arbre ou un blob local dans un clone partiel, puis lire la revue. | Une seule actualisation locale, au plus une demande ciblée à Git officiel, puis une seule relance. Une absence persistante produit `GIT_OBJECT_MISSING`. | Compteurs d'appels de l'opération et de l'hydratation, test avec objet toujours absent. |
| G2. La récupération Git ne modifie ni le worktree ni l'index. | Déclencher l'hydratation avec des changements non indexés et indexés. | Les octets, modes et révisions du worktree et de l'index restent identiques, même si l'hydratation échoue. | Empreintes avant et après pour le worktree et l'index. |
| G3. Seuls les clones partiels déclarés peuvent hydrater. | Signaler un objet manquant dans un dépôt normal ou un dépôt dont le remote n'est pas promisor. | Macro actualise l'ODB, ne lance aucun fetch et suspend la revue avec l'erreur typée. | Test avec faux exécuteur Git qui échoue s'il est appelé. |
| G4. L'annulation gagne de façon déterministe. | Annuler avant l'enregistrement, pendant la lecture bornée, pendant Git officiel et juste avant la relance. | L'opération se termine comme annulée, ne relance pas la lecture et tue le groupe de processus Git si nécessaire. | Tests d'interleaving avec barrières et compteurs. |
| G5. Les diagnostics envoyés à l'interface ne révèlent aucun chemin externe. | Faire échouer Git avec un chemin de profil, de remote local ou de dépôt externe dans stderr. | Le code, l'objet, l'opération et une sortie bornée restent disponibles. Les chemins sensibles sont remplacés ou supprimés. | Tests avec chemins sentinelles dans les messages et événements sérialisés. |
| C1. Un checkpoint appartient à une seule tâche et à un seul projet. | Ouvrir, supprimer ou restaurer le checkpoint de la tâche A avec la tâche B, ou avec un autre projet. | Erreur typée avant toute création, configuration, suppression, écriture d'index ou restauration. | Instantanés du dépôt interne et du projet avant et après chaque refus. |
| C2. Une absence ou une corruption ne recrée pas l'historique. | Supprimer le checkpoint ou un objet après sa création, puis appeler `ensure`, la revue ou la restauration avec son identifiant persisté. | `DIRECT_CHECKPOINT_MISSING` ou `DIRECT_CHECKPOINT_CORRUPT`. Aucun nouveau dépôt, commit ou fichier n'apparaît. | Test du marqueur d'identité et comparaison complète de la racine des checkpoints. |
| C3. Les opérations d'un checkpoint sont sérialisées. | Entrelacer capture, hydratation, suppression et restauration sur le même identifiant. | Une opération observe un état cohérent. La suppression ne peut pas retirer un dépôt utilisé et une capture ne peut pas ressusciter un checkpoint supprimé. | Tests avec barrières sur le verrou propre au checkpoint. |
| C4. Les opérations d'un projet direct préservent les écritures concurrentes. | Modifier un fichier après sa validation, pendant la préparation d'une capture ou d'une restauration. | Macro refuse la publication ou restaure seulement les entrées qu'elle a créées. L'écriture concurrente reste intacte. | Tests avec empreintes de contenu, type d'entrée et mode avant la publication. |
| C5. Chaque paire de blobs et chaque renommage est complète. | Retirer un blob HEAD ou index, fournir une ancienne cible de renommage absente, ou remplacer un blob par un objet d'un autre type. | La revue ou la mutation échoue avant écriture. Aucun côté de la paire ne vient d'une révision différente. | Tests de blob absent, mauvais type, renommage incomplet et révision changée entre les deux lectures. |
| C6. Les chemins restent contenus. | Placer un lien symbolique, une jonction Windows ou un point de réanalyse dans un parent, puis lire ou restaurer un enfant. | TypeScript ne construit pas de cible externe et Rust refuse l'accès par capacité. Une cible de lien qui sort de la racine devient une valeur neutre avant sérialisation. Aucun octet ni chemin externe n'est lu, divulgué, écrit, renommé ou supprimé. | Scénarios Unix et Windows avec fichier sentinelle extérieur. |
| C7. Une restauration absente, invalide ou annulée ne mute rien. | Demander zéro chemin, un chemin inconnu, une carte de révisions incomplète, une révision périmée ou annuler avant publication. | Aucun fichier, répertoire parent, fichier temporaire, index ou référence Git ne change. | Arbre de fichiers et état Git comparés avant et après. |
| C8. Les lectures et l'hydratation sont bornées. | Utiliser un blob, un lien ou un fichier de plusieurs fois la limite, un historique avec trop d'objets ou un très grand nombre de chemins. | Macro partage un budget de 256 Mio et de 100 000 objets entre l'historique et l'index. Elle parcourt au plus 4 096 entrées lors de la capture initiale et refuse aussi les listes IPC plus grandes avant de les cloner ou de les développer. | Lecteurs instrumentés, fichiers creux et compteurs d'objets, d'entrées et de chemins. |
| C9. Un rollback ne retire que les effets de l'opération. | Faire échouer la deuxième entrée d'une restauration, puis remplacer la première entrée publiée ou sa sauvegarde par une écriture concurrente. | Le rollback conserve l'écriture concurrente. Le nettoyage vérifie l'empreinte exacte et ne supprime jamais récursivement un chemin qui a changé de type. | Interleaving déterministe avec échec partiel, remplacement fichier vers répertoire et empreinte de publication. |

## Ordre obligatoire d'une restauration directe

1. Valider `taskId`, `checkpointId`, l'identité du projet et les racines canoniques.
2. Prendre le verrou du checkpoint et le verrou du projet direct.
3. Ouvrir le dépôt sans le créer et sans réparer ses fichiers internes, puis charger une seule instance de l'index. Vérifier `HEAD`, tous les commits atteignables, leurs arbres, les blobs et cette instance de l'index.
4. Résoudre l'identifiant opaque du snapshot dans le registre backend, puis valider son propriétaire, la révision actuelle de `HEAD` et de l'index, tous les chemins, les paires de blobs, les renommages, les limites et la carte complète des révisions attendues.
5. Relire chaque entrée du worktree par capacité et comparer sa révision attendue.
6. Préparer les temporaires et sauvegardes dans les parents déjà validés, puis restaurer uniquement depuis l'instance de l'index dont la révision a été autorisée.
7. Vérifier l'annulation pendant la copie, avant chaque déplacement de sauvegarde et immédiatement avant chaque publication, puis publier les mutations.
8. En cas d'échec, restaurer seulement les entrées dont l'empreinte publiée correspond encore à celle de l'opération.

Une erreur aux étapes 1 à 5 doit être strictement sans mutation.
