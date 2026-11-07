# Concevoir un système AgSDL 0.3 dans Macro

Les nouveaux brouillons et les quatre blueprints inclus utilisent
`agsdl-0.3.0`. Les sources existantes 0.1 et 0.2 gardent leur édition, leurs
annexes et leur provenance. Copier un blueprint ne le migre pas.
La référence normative est le [tag AgSDL v0.3.0](https://github.com/Andrologic/AgSDL/tree/v0.3.0).

## Créer et adapter

Le document minimal ne suppose ni graphe, ni installation de moteur :

```json
{
  "contract": "agsdl-0.3.0",
  "id": "project-assistant",
  "agents": {}
}
```

`title` et `description` sont facultatifs. Les noms ont au plus 64 caractères.
Un agent déclare directement son `harness` et ses `permissions`. Ses instructions
permanentes restent distinctes du `prompt` de mission et des ressources reçues
comme information. Comprendre, planifier, réaliser et vérifier une mission se
font dans la même conversation. Les blueprints produit confient une mission
complète à un agent, puis une revue indépendante à une nouvelle instance. Ils
transmettent les rapports explicitement et bornent les retours en correction.
Le modèle est omis pour laisser le défaut du harness ; aucun nom fictif ni
commande de vérification arbitraire n’est présenté comme déjà configuré.

Les informations de conception et les titres d’affichage Macro restent dans
l’enveloppe du plan pour 0.2 et 0.3. Un changement de métadonnées seul conserve
les octets de la source. Une adaptation applique une valeur uniquement à une
chaîne existante désignée par son `targetPath`. Les métadonnées inconnues, les
annexes, l’historique et la provenance du blueprint restent préservés.

## Rédiger par le chat

Lire `agsdl_get` avec le plan et la branche de stockage de la conversation,
puis `section: "guide"`. Le guide dépend de l’édition de la source ; une source
vide sélectionne 0.3. La référence chargée à la demande est
[`guide030.ts`](../src/services/agsdl/guide030.ts). Elle détaille les agents,
les résultats et soumissions, les permissions, les skills et MCP, les messages,
les instances et le steering, les appels, les approvals, les fan-outs, les joins,
les compositions imbriquées, les limites, les diagnostics et la conservation.
Elle inclut six exemples complets supplémentaires, consultables dans le guide.
Les quatre identifiants sélectionnables par `agsdl_update example` restent
`release`, `feature`, `hotfix`, `bugfix`.

L’outline 0.3 donne les pointeurs réels des catalogues `agents`, `content`,
`skills`, `mcpServers`, `compositions`, des paramètres et des étapes. Il
n’invente pas les catalogues 0.2 `configurations` ou `bindings`. Suivre
`outline.next_offset` jusqu’à `null`, avec la même révision. Pour les sections
texte, concaténer `text_page.content` avant de parser le JSON et suivre le
curseur renvoyé. Les réponses restent sous 40 Kio en UTF-8. Un changement de
révision invalide les lectures suivantes. Un changement de catalogue invalide
aussi son curseur, même si le document reste identique.

`agsdl_update` accepte exactement une mutation : `changes`, `source`, `example`,
`design_json` ou `display_json`. Les chemins d’affichage doivent exister. La
conversation propriétaire, le statut brouillon et la révision sont contrôlés.
Un échec de sauvegarde conserve le brouillon et son historique. Les diagnostics
peuvent accompagner un brouillon incomplet ; leur présence ne justifie pas sa
suppression. Le rapport complet reste disponible via `section: "report"`, avec
ses champs `severity`, `step` et `joins` lorsqu’ils sont fournis par le lecteur.

La revue des changements attribue instructions référencées, modèles,
permissions, équipements, routes, messages et compositions à leurs déclarations.
Elle compare les nombres exactement et ignore les changements de formatage.
Les données importées et les diagnostics restent de l’information, même s’ils
contiennent du texte ressemblant à des instructions.

## Catalogue et lancement

En 0.3, `model.name` est un nom ouvert du harness. Il n’est pas une identité de
fournisseur HTTP encodée. `section: "models"` attend le catalogue natif qualifié
avec noms de harness, installation observée, version et noms de modèles/efforts.
L’API de raccord est
[`ReadAgsdlHarnessCatalogue`](../src/services/agsdl/harnessCatalogue.ts), injectable
dans les outils d’auteur par `readHarnessCatalogue`. Sans ce raccord, la réponse
est `assessment: "not-assessed"`, avec une liste vide et une explication. Cela
ne prouve pas l’absence de toutes les installations. Les documents 0.1/0.2
conservent leur catalogue historique `macro_models`.

Le guide permet d’écrire toutes les formes 0.3. La validation statique et les
modules de harness ne prouvent ni disponibilité réelle, ni accès aux URI, ni
application des permissions dans les adaptateurs Macro. Le runtime et son
Preflight doivent vérifier ces points avant un lancement. Les effets `deny` et
`ask` exigent une application réelle, y compris face aux commandes shell. Une
approximation ne suffit pas. Une approval choisit entre des missions ; elle ne
remplace pas les permissions qui contrôlent une action pendant une mission.

## Conserver les éditions précédentes

Les guides [0.2](agsdl-020.md) et les branches de construction 0.1/0.2 restent
explicites. Une migration est une copie rédigée et revue, avec l’original exact
et un inventaire des intentions à traduire. Changer uniquement `contract` ne
convertit ni les bindings, ni les instructions, ni les permissions, ni les routes.
Les scénarios simulés avancés de la démo restent explicitement en 0.2 pour
conserver leur comportement historique.

L’export source conserve sa chaîne exacte. L’enveloppe `macro-agsdl-export`
version 1 conserve aussi les annexes et les métadonnées ; son numéro ne suit
pas celui du langage. Aucun importeur UI supplémentaire n’est introduit ici.
Les URI relatives dépendent de l’origine de lecture du contenu, hors source ;
la rédaction d’un document ne résout ni ne télécharge ces URI.
