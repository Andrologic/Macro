# Ressources des machines

`instance.telemetry` exige `host-telemetry-1`. `project.icon` exige `project-icons-1`. Le consommateur et le producteur annoncent séparément ces capacités. Le relais atteste leur sélection dans la livraison. L'autorisation courante doit accorder `supervise` avant la lecture et avant la réponse. Une capacité ne donne aucune permission. Un ancien relais peut refuser ces annonces ; le producteur réessaie sans elles et conserve les opérations historiques.

Les formes de `projects.list`, les anciens appels ACCOUNT et le contrat v1 restent inchangés. Les ressources machines utilisent des opérations distinctes. Les références complètes et les identités des requêtes/réponses sont corrélées par le validateur canonique.

## CPU et mémoire

Un échantillon contient `instance_id`, un `sample_id` opaque, `observed_at`, `expires_at`, `availability`, `reason`, `cpu_percent`, `memory_used_bytes` et `memory_total_bytes`. Sa durée de validité maximale est de cinq secondes. En état `available`, la raison est nulle et les nombres sont finis. La mémoire utilisée ne dépasse pas la mémoire totale. En état `unavailable`, les trois nombres sont nuls et la raison vaut `unsupported_platform` ou `measurement_failed`. Une mesure absente ou expirée ne représente jamais zéro.

Le CPU est global, normalisé entre 0 et 100 sur l'ensemble des processeurs logiques, à partir de deux compteurs espacés d'au moins 250 ms. Le premier appel attend cet intervalle. La commande et son cache sont sollicités par les consultations. Aucun timer de collecte permanent n'est créé. Les définitions des compteurs et de la mémoire par système figurent dans le module natif `host_telemetry`.

## Logos

La requête porte une référence instance/workspace/projet. La réponse conserve cette référence et contient une observation expirant au plus après cinq minutes. Une ressource disponible contient un identifiant opaque lié à la référence et au SHA-256 des octets, le hash, le type MIME, la taille brute et les données base64. Les seuls formats exportables sont PNG, JPEG et WebP avec signature correspondante. Les SVG et ICO du résolveur desktop peuvent conserver leur usage local ; l'export utilise alors l'état `unavailable` et le consommateur affiche son icône de repli.

La limite est de 98 304 octets bruts et 131 072 caractères base64, après encodage. Le plafond global d'enveloppe de 256 Kio reste applicable. Le résolveur natif existant conserve sa lecture bornée. Chaque consultation résout à nouveau l'icône pour détecter un changement de fichier. Le cache d'export contient au plus 64 ressources et 8 Mio de base64. Le retrait ou le déplacement d'un projet, un changement de contexte ou de politique, et la fermeture du producteur invalident les ressources concernées. Les réponses ne contiennent aucun chemin et ne permettent aucun téléchargement par URL.

## Dernière activité

L'extension du relais intégré est importée : `sessions.list` accepte `body.include_last_seen: true`, répété sur chaque page. Les items observés peuvent alors contenir `last_seen_at`. Sans opt-in ou avec `false`, ils gardent leur forme historique exacte. Un client qui reçoit `validation_failed` pour l'opt-in recommence une capture initiale sans ce paramètre ; il conserve les contrôles de pagination, d'identité et de révocation.

Les instances v1 possèdent déjà le champ optionnel `last_seen_at`. Aucune nouvelle capacité n'est nécessaire pour l'activité. La date rapporte une requête réussie observée et persistée par le relais, avec une cadence d'écriture d'une minute. Elle est indépendante de la présence et peut rester visible après déconnexion. L'absence indique une activité inconnue ; `created_at` ne sert jamais de remplacement.

Les tests de ce lot utilisent des données synthétiques. La recette sur les systèmes et appareils réels reste à réaliser.
