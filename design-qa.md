# Vérification des sélecteurs du composeur

Date de vérification : 14 octobre 2026.

## Résultat

Aucun écart P0, P1 ou P2 restant dans le périmètre des deux sélecteurs.
Le composeur réunit fournisseur et modèle dans une liste à plat avec recherche.
Le raisonnement reste une liste séparée derrière le bouton du niveau courant.
Une coche identifie chaque sélection ; un seul menu reste ouvert à la fois.

## Références et preuves

Les chemins ci-dessous sont relatifs au dossier de preuves visuelles de cette tâche,
conservé hors du dépôt. Les images de l'application sont des captures Playwright du
runtime Tauri réel, avec données synthétiques et fournisseur HTTP local.

- Source visuelle : `model-selector/raisonnement-liste-simple.png`, 1536 × 1024 pixels.
- Modèles : `model-selector/implementation/models-full.png`, fenêtre CSS et image de 1440 × 1000 pixels.
- Raisonnement : `model-selector/implementation/reasoning-full.png`, même fenêtre.
- Détails : `models-detail.png` et `reasoning-detail.png`, dans le même dossier de captures.
- Comparaison réunissant source et captures : `model-selector/implementation/comparison.png` et `comparison.html`.
- Résultats : `model-selector/implementation/playwright-results.json`.

Densité des captures : 1 pixel par pixel CSS. Les détails sont comparés à leur taille
native. La maquette est une planche contenant des vues agrandies ; son illustration
du shell est réduite séparément. La comparaison générale vérifie le placement dans
le composeur, sans imposer les proportions fictives de cette illustration au shell
existant de Macro. Le panneau de modèles réel mesure 380 pixels de large.

États comparés : thème Macro sombre, français, GPT-5 chez OpenAI sélectionné ; menu de
modèles ouvert ou liste de raisonnement ouverte avec le niveau Moyen sélectionné.
Les huit lignes réelles comprennent les deux modèles Macro AI déjà présents, en plus
des six couples du jeu synthétique. Leur ordre suit le catalogue existant.

## Comparaison visuelle

- Typographie : polices et tailles existantes de Macro conservées. Noms des modèles
  sur une seule ligne à 14 pixels, fournisseurs secondaires à 12 pixels. Les boutons
  gardent la densité du produit existant. Les vues agrandies de la maquette présentent
  naturellement des textes plus grands.
- Espacement : bouton fournisseur/modèle unique, bouton de raisonnement adjacent,
  menus ancrés au-dessus. Une ligne par couple, fournisseurs alignés à droite.
  La liste de raisonnement conserve une largeur compacte de 180 pixels.
- Couleurs : tokens existants du thème, état sélectionné teinté par la couleur
  primaire, texte principal contrasté, fournisseurs en texte secondaire.
- Images et icônes : aucune image générée dans l'interface ; icônes existantes pour
  recherche, coche et chevron. Aucune icône de cerveau et aucun slider.
- Contenu : libellés issus des traductions et du catalogue configuré. Noms longs
  tronqués avec leur contenu complet dans le titre du résultat. Seuls les niveaux
  de raisonnement déclarés par le modèle sont proposés.

Historique de comparaison : la première comparaison réunissant les captures finales
et la maquette n'a identifié aucun écart P0/P1/P2 nécessitant une correction visuelle.
Les vérifications de préparation du profil et les ajustements des scénarios de test
ne sont pas comptés comme des itérations de comparaison visuelle.

## Validation fonctionnelle

21 scénarios Playwright réussis. Ils couvrent la sélection du couple exact lorsque
l'identifiant du modèle est partagé, la recherche sans sélection implicite, les
fournisseurs et modèles exclus, les deux menus à la souris et au clavier, Échap et
le retour du focus, la liste vide, l'effacement de recherche, le masquage du
raisonnement indisponible, les fenêtres 1024 × 768 et 800 × 600, l'envoi réel au
fournisseur local avec `reasoning_effort: high`, puis la restauration après
rechargement. Aucune erreur JavaScript non interceptée pendant le parcours.

Les cinq fichiers de tests ciblés passent : sélecteur de modèles, raisonnement,
navigation des listes, store des fournisseurs et ChatZone. Le typecheck, le lint et
l'audit des six langues passent également. Le contrôle différentiel local est
consigné dans le rapport de livraison après le commit.

## Limites établies

Le jeu de test utilise des fournisseurs synthétiques compatibles OpenAI pour vérifier
le routage et la transmission du raisonnement. Il ne valide pas une authentification
ChatGPT ou les droits d'un compte chez un fournisseur externe.

Une limitation préexistante a été reproduite pendant la préparation : le schéma de
configuration des modèles manuels refuse les champs de raisonnement que la commande
d'enregistrement essaie d'écrire. Ce chantier ne modifie pas ce schéma. Les scénarios
emploient donc les métadonnées de modèles natives, et non un enregistrement manuel
de niveaux de raisonnement. Le sélecteur conserve les modèles manuels déjà chargés.

## Checklist

- [x] Sélecteur fournisseur/modèle unique et liste à plat.
- [x] Raisonnement dans une liste séparée, sans slider ni icône de cerveau.
- [x] Sélection atomique et contrôle des couples encore utilisables.
- [x] Navigation clavier, focus et menus exclusifs.
- [x] Captures réelles et comparaison visuelle.
- [x] Tests ciblés, typecheck, lint et traductions.

final result: passed
