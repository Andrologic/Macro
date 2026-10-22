# Système sériel à trois moteurs

[L’exemple AgSDL](examples/agsdl-mixed-engine.json) déclare trois Agents,
Macro, Claude SDK contrôlé et Codex natif isolé. Le flow fini visite chacun
deux fois, à des adresses de step distinctes. Les déclarations et configurations
restent les mêmes entre les visites. Il ne crée ni worktree ni tâche parallèle.

Avant Start, sélectionner dans Macro les modèles disponibles pour chaque
configuration. Les identités `configure-http-provider`, `configure-http-model`
et `configure-codex-model` sont des paramètres à remplacer, pas des fournisseurs
installés. Claude utilise `claude-haiku-5-5` si ce modèle est disponible dans le
profil contrôlé. Les prérequis et limites des moteurs externes sont décrits dans
[Codex natif](agsdl-codex-native.md) et [Claude contrôlé](agsdl-claude-controlled.md).
Un profil absent ou une configuration incompatible bloque la compilation ;
aucun autre moteur ne le remplace.

Le premier Message peut contenir cette ressource inline. Conserver les nombres
dans leur texte JSON exact, sans passage par un parseur à précision flottante.

```json
{"resources":{"report":{"value":{"n":9007199254740993,"decimal":0.12345678901234567890123456789,"label":"Été à Montréal"},"mediaType":"application/json"}}}
```

Chaque Agent publie le résultat nommé `report`. Les steps Prepare sélectionnent
explicitement `results.report`, avec son média et sa valeur, et décrivent le
producteur dans leur prompt. Ils ne transfèrent pas les autres résultats, le
transcript ou la mémoire native. Un simple lien Agent vers Agent ne transmet
que le texte visible dans une ressource `result` et ne suffit pas à ce parcours.
Une ressource conserve son rôle de donnée ; cela ne garantit pas qu’un modèle
ignorera toute instruction qu’elle pourrait contenir.

Les trois mémoires conservent leur propre format. Claude reprend la session
capturée, Codex le thread capturé et Macro son historique propre à l’instance.
Une deuxième visite conserve l’instance et sa tâche Operate, tout en recevant
une nouvelle identité d’activation et de livraison. Le journal SQLite, les
admissions FIFO et la pompe existante décident des continuations. Les tâches
Operate sont une projection de ce journal.

La publication reste soumise au validateur. Une ressource absente ou une
publication invalide ne livre pas le successeur normal. Une frontière native
incertaine bloque le successeur causal ; elle ne permet ni nouvelle session
de remplacement ni rejeu automatique du modèle. La reprise d’un prepare ou
d’un commit déjà exécuté récupère son reçu, sans réexécuter l’Agent.

## Portée des contrôles

Le test `mixedEngine.test.ts` compile l’exemple avec trois observations
synthétiques et vérifie le transfert exact, les revisites et le refus d’un profil
natif absent. Il n’exécute ni modèle ni SQLite. Les tests des adaptateurs, de la
pompe et du repository vérifient séparément leurs frontières de panne. Les
preuves de qualification native doivent en plus identifier le runtime, le
workspace synthétique, les fichiers SQLite ouverts, les configurations capturées,
les publications retenues, les mémoires et les tâches projetées.

Un transport Macro HTTP vers un fournisseur local simulé prouve ce transport,
pas une inférence du modèle annoncé par le simulateur. Une perte de reçu
injectée côté appelant après le vrai IPC prouve la récupération de cette
frontière, pas une coupure physique du réseau. Les rapports locaux distinguent
ces contrôles des sessions Claude SDK et Codex natives réelles.

La [matrice de qualification](agsdl-qualification.md#chaîne-macro-claude-et-codex)
détaille les contrôles natifs, les injections côté appelant et les garanties
réutilisées des adaptateurs. Pour une review d’un changement logiciel, suivre
le [contrat d’artefact de patch](agsdl-software-review.md).
