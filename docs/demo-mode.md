# Mode démo intégré

Le mode démo charge les composants, les stores et la navigation de Macro. Un
backend en mémoire remplace les appels Tauri avant le chargement de l'application.
Il permet de travailler l'interface avec des données fictives sans ouvrir un
profil utilisateur ou un dépôt réel.

## Lancement

```sh
bun run dev:demo
```

Ouvrir `http://127.0.0.1:1438/`. Le bandeau « Démo · Données fictives » identifie
ce mode. « Réinitialiser » recharge le scénario initial, y compris les préférences.
Le port est strict pour éviter d'ouvrir accidentellement une autre instance.

Le lancement actuel utilise le frontend réel dans le navigateur. Ce mode refuse
de démarrer dans une fenêtre native qui possède déjà un backend Tauri. Un
lancement natif devra isoler le profil avant le démarrage du backend.

## Scénario et interactions

- Deux projets fictifs : Luma Mobile et Atlas Studio.
- Deux plans AgSDL 0.2, avec graphes et conversations.
- Consultation et modification des instructions et du modèle d'un agent.
- Tâches avec états et conversations, navigation entre les modes.
- Composeur normal et réponses locales simulées, sans appel à un fournisseur.
- Paramètres, catalogue de modèles, skill et serveur MCP fictifs.
- Terminal simulé. Aucune commande n'est exécutée.
- Fichiers et modifications conservés uniquement en mémoire.

Les vues sont celles du produit actuel. Ce socle sert à retravailler ensuite
Architect, Operate et les parcours d'export dans l'application elle-même.

## Limites actuelles

Toutes les commandes de Macro ne sont pas encore simulées. Les opérations
inconnues échouent explicitement, sans transfert vers le backend réel. Le dialogue
d'exécution peut lire son état vide ; une exécution AgSDL complète, les approbations,
les intégrations externes, la dictée, la sauvegarde et la mise à jour de
l'application ne sont pas reproduites. Les réponses du chat sont prédéfinies.

Ne pas qualifier ce mode de démonstration exhaustive avant d'avoir simulé et
vérifié ces parcours. Les journaux `[demo:unsupported]` identifient les commandes
à compléter. Ajouter leurs contrats dans `src/demo/runtime.ts` et des fixtures
dans `src/demo/fixtures.ts`, sans ajouter de contournement dans les composants.

## Isolation et vérification

Le mode nécessite `DEV` et `VITE_MACRO_DEMO=1`. La compilation de production élimine
son import. Les préférences et les stockages web sont en mémoire. Les requêtes
HTTP natives sont interceptées et les requêtes web externes sont refusées. Le
catalogue externe de modèles reçoit une réponse locale vide ; les modèles de
la démo sont fournis explicitement.

```sh
bun test src/demo/runtime.test.ts
bun run typecheck
```

Pour une vérification visuelle, changer de projet, ouvrir un agent, modifier ses
instructions et son modèle, enregistrer, envoyer un message, parcourir les tâches
et les paramètres, puis réinitialiser. Les données initiales doivent réapparaître.
