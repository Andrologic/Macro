# Ressources des machines

`instance.telemetry` exige `host-telemetry-1`. `project.icon` exige `project-icons-1`. Le consommateur et le producteur annoncent séparément ces capacités. Le relais atteste leur sélection dans la livraison. L'autorisation courante doit accorder `supervise` avant la lecture et avant la réponse. Une capacité ne donne aucune permission. Un ancien relais peut refuser ces annonces ; le producteur réessaie sans elles et conserve les opérations historiques.

Les formes de `projects.list`, les anciens appels ACCOUNT et le contrat v1 restent inchangés. Les ressources machines utilisent des opérations distinctes. Les références complètes et les identités des requêtes/réponses sont corrélées par le validateur canonique.

## CPU et mémoire

Un échantillon contient `instance_id`, un `sample_id` opaque, `observed_at`, `expires_at`, `availability`, `reason`, `cpu_percent`, `memory_used_bytes` et `memory_total_bytes`. Sa durée de validité maximale est de cinq secondes. En état `available`, la raison est nulle et les nombres sont finis. La mémoire utilisée ne dépasse pas la mémoire totale. En état `unavailable`, les trois nombres sont nuls et la raison vaut `unsupported_platform` ou `measurement_failed`. Une mesure absente ou expirée ne représente jamais zéro.

Le CPU est global, normalisé entre 0 et 100 sur l'ensemble des processeurs logiques, à partir de deux compteurs espacés d'au moins 250 ms. Le premier appel attend cet intervalle. La commande et son cache sont sollicités par les consultations. Aucun timer de collecte permanent n'est créé. Les compteurs système sont définis dans le module natif `host_telemetry`.

| Système | CPU occupé | Mémoire physique utilisée |
| --- | --- | --- |
| Linux | Delta user + nice + system + irq + softirq + steal, divisé par ce delta plus idle + iowait. Guest et guest_nice sont déjà inclus dans user/nice. | `MemTotal - MemAvailable`, converti de Kio en octets. |
| macOS | Delta user + system + nice, divisé par ce delta plus idle, depuis `HOST_CPU_LOAD_INFO`. | `(internal_page_count - purgeable_count + wire_count + compressor_page_count) × taille de page`. Total depuis `hw.memsize`. Le cache de fichiers et les pages purgeables sont exclus. Le stockage physique comprimé est compté, pas son équivalent décomprimé. |
| Windows | Somme des deltas kernel - idle + user sur les processeurs, divisée par kernel + user. Une réponse partielle est refusée. | `ullTotalPhys - ullAvailPhys`, depuis `GlobalMemoryStatusEx`. |

Ces définitions de mémoire dépendent du système. Elles ne représentent pas un classement comparable de pression mémoire. Les topologies Windows à plusieurs groupes de processeurs restent à vérifier lors de la recette matérielle.

## Logos

La requête porte une référence instance/workspace/projet. La réponse conserve cette référence et contient une observation expirant au plus après cinq minutes. Une ressource disponible contient un identifiant opaque lié à la référence et au SHA-256 des octets, le hash, le type MIME, la taille brute et les données base64. Les seuls formats exportables sont PNG, JPEG et WebP avec signature correspondante. Les SVG et ICO du résolveur desktop peuvent conserver leur usage local ; l'export utilise alors l'état `unavailable` et le consommateur affiche son icône de repli.

La limite est de 98 304 octets bruts et 131 072 caractères base64, après encodage. Le plafond global d'enveloppe de 256 Kio reste applicable. Le résolveur natif existant conserve sa lecture bornée. Chaque consultation résout à nouveau l'icône pour détecter un changement de fichier. Le cache d'export contient au plus 64 ressources et 8 Mio de base64. Le retrait ou le déplacement d'un projet, un changement de contexte ou de politique, et la fermeture du producteur invalident les ressources concernées. Les réponses ne contiennent aucun chemin et ne permettent aucun téléchargement par URL.

### Vérification du hash

`validateMessage` et `validateExchange` restent synchrones et compatibles avec leurs appels historiques. Ils vérifient la forme, la signature du format, la taille et la corrélation, mais ne calculent pas SHA-256. Leur résultat seul ne prouve donc pas l'intégrité des octets.

Avant d'accepter, d'afficher, de mettre en cache ou d'émettre un logo disponible, chaque consommateur appelle `validateResourceIntegrity(envelope)` depuis `validate.mjs`, ou son équivalent qui recalcule SHA-256 sur les octets base64 décodés. Le helper utilise Web Crypto dans les navigateurs, Bun et Node. Une absence de Web Crypto refuse la ressource. Le desktop génère ce même helper dans son validateur et l'appelle avant la réponse et avant l'émission native. Son producteur vérifie aussi le hash fourni par le résolveur local.

`fixtures/integrity-invalid/project-icon-wrong-sha256.json` conserve une forme valide avec un hash faux. Il est refusé par la couche d'intégrité. Ces exemples sont séparés des fixtures de forme invalides pour préserver le contrat du validateur synchrone.

## Dernière activité

L'extension du relais intégré est importée : `sessions.list` accepte `body.include_last_seen: true`, répété sur chaque page. Les items observés peuvent alors contenir `last_seen_at`. Sans opt-in ou avec `false`, ils gardent leur forme historique exacte. Un client qui reçoit `validation_failed` pour l'opt-in recommence une capture initiale sans ce paramètre ; il conserve les contrôles de pagination, d'identité et de révocation.

Les instances v1 possèdent déjà le champ optionnel `last_seen_at`. Aucune nouvelle capacité n'est nécessaire pour l'activité. La date rapporte une requête réussie observée et persistée par le relais, avec une cadence d'écriture d'une minute. Elle est indépendante de la présence et peut rester visible après déconnexion. L'absence indique une activité inconnue ; `created_at` ne sert jamais de remplacement.

Les tests de ce lot utilisent des données synthétiques. La recette sur les systèmes et appareils réels reste à réaliser.
