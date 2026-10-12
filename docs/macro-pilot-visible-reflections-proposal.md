# Proposition : réflexions visibles dans Pilot

Statut : proposition technique, réalisation soumise à accord. Périmètre : conversations Chat et Implement. La source de référence est la présentation du message assistant dans Macro.

## Sources existantes

| Source | Comportement vérifié dans le code |
| --- | --- |
| `src/components/chat/ChatZone.tsx` et `MarkdownRenderer.tsx` | Le contenu du message assistant passe dans le renderer. Ses blocs `thinking` sont affichés dans un panneau replié par défaut. Le parser reconnaît `think` et `thinking`, y compris un bloc ouvert pendant la génération. Les groupes d’outils sont des blocs distincts. |
| `src/services/ai/chatCompletionsAdapter.ts` et `streamingChatExecution.ts` | Les textes `reasoning` ou `reasoning_content` effectivement affichés deviennent du contenu `<think>`. `reasoning_details` reste dans la représentation provider. |
| `src/services/ai/responsesCodec.ts` et `nativeAdapter.ts` | Le résumé visible de ChatGPT/Copilot est intégré au contenu du message. Les éléments chiffrés de reprise restent dans les données provider. |
| `src/services/chatPersistenceService.ts` et `chatDbMappers.ts` | Le contenu affiché est persisté avec le vrai message et son turn, puis reconstruit pour la présentation. `hidden_context` et les JSON provider sont des champs séparés. |
| `src/services/macroPilot/conversationText.ts` | L’export actuel extrait la réponse finale et retire les blocs de réflexion. Les reçus `assistantProvenance` attestent la réponse finale et ne suffisent pas à attester les réflexions. |

## Réalisation proposée

Extraire une projection pure commune au renderer et à l’export. Elle sélectionne uniquement les blocs `thinking` de la présentation assistant et conserve leur ordre. Les traces d’outils, arguments, résultats, questionnaires, diagnostics et champs provider ne deviennent pas des réflexions. Les blocs historiques reconnus par cette même présentation sont lisibles ; une source ambiguë est `withheld`. Aucun texte n’est déduit de données chiffrées ou non affichées.

Ajouter la capacité opt-in `conversation-reflections-1` et l’opération `conversation.reflections.read`. La requête porte la référence complète Chat/Implement, `message_id` et une continuation opaque facultative. La réponse porte cette même référence, l’association au message et au turn lorsqu’il existe, une capture datée, sa révision, son expiration et les fragments ordonnés de blocs. Chaque fragment indique l’identité et l’ordre du bloc, son offset UTF-8 et son état complet ou partiel. Les états sans texte distinguent absence, génération en attente, contenu retenu, source trop grande et indisponibilité. Les opérations et schémas historiques restent inchangés.

Prévoir l’historique durable et les blocs actuellement affichés pendant une génération. Un bloc ouvert porte l’état partiel ; un message actif sans réflexion donne l’état attente. Une capture fige les fragments observés. La page suivante continue cette capture. Un ajout de texte conserve son préfixe figé seulement si les octets déjà observés et le propriétaire restent identiques ; une réécriture ou une réduction invalide la capture. Une nouvelle observation du flux utilise une nouvelle révision. La source active doit correspondre au vrai message assistant de la conversation et au propriétaire courant de sa génération. Les données finales proviennent de la présentation persistée.

Le lecteur existant `getMessage` borne son DTO natif à 4 Mio mais charge aussi les champs privés de reprise. Préférer un lecteur natif minimal et borné pour cette extension, limité au contenu de présentation, identité et métadonnées nécessaires des outils. Réserver la mémoire avant IPC et contrôler la taille dans la transaction avant chargement. Le wrapper, le registre et les types IPC devront être raccordés. Une compilation native impossible reste une vérification différée explicitement déclarée.

## Bornes et autorité

Proposition de limites : source de présentation de 1 Mio, 128 blocs, fragments de 8 Kio UTF-8 et texte de page de 64 Kio au plus. Refuser le dépassement avant parse. Inspecter toute la projection disponible au moment de la capture avant son premier fragment, avec la politique existante sur secrets et chemins natifs. Réserver 16 Mio de travail avant lecture/projection ; plafonner les captures conservées à 32 Mio par instance et 16 Mio par session, avec 32 et 16 captures. Ces réservations s’ajoutent aux budgets existants et ne mesurent pas le RSS.

Expiration absolue proposée : cinq minutes pour l’historique et quinze secondes pour une capture active. Les lectures ne prolongent pas l’expiration. Cache uniquement en mémoire desktop, lié au compte, à la session, à l’instance, à la référence complète, au message, à la politique et à `authority_binding`. Aucun texte de réflexion dans le journal d’événements ou le cache générique de réponses. Réutiliser l’invalidation de conversation et arrêter les lectures lorsque la préférence mobile est désactivée, l’écran fermé ou le bloc replié.

La permission requise est `supervise`. La capacité ne donne aucun accès. Vérifier la cible et le binding avant lecture, puis autoriser avant la comparaison finale de source sous une échéance fixe. Suppression, modification du message hors ajout au préfixe actif attesté, changement de propriétaire actif, révocation, restauration, déconnexion ou changement de politique invalident les captures. Les retries de transport revalident la réponse. Un ancien relais peut refuser la capacité et conserver les fonctions existantes.

## Vérification et fin de tranche

Après accord, implémenter le contrat canonique, la projection commune, le lecteur borné, le host, les raccords runtime/transport et les tests ciblés. Couvrir historique et génération interrompue, multi-turn, Unicode, pages, références étrangères, bornes, secret après le premier fragment, mélange avec outils et champs provider non affichés. La préférence mobile reste désactivée par défaut et les blocs restent repliés. Relais et mobile adaptent leurs propres copies après livraison du contrat.

Terminer par un candidat commité, un worktree propre et une revue indépendante Sol/high. La compilation native complète et la recette visuelle ou sur appareils restent distinctes des preuves synthétiques disponibles. Cette proposition ne modifie aucun comportement produit.
