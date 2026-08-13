# QA visuelle — navigation Architecte

## Références et état comparé

- Vérité visuelle source : `C:\Users\oscar\.codex\generated_images\019fe5f5-3341-7a72-b886-00f9e7044a41\exec-e625b158-f0d7-4224-9dc9-5d9501b98e5f.png` (`1834 × 858` px).
- Capture du shell réel : `C:\Users\oscar\.codex\worktrees\62b3\Macro\design-qa-artifacts\architect-shell-empty-wide.png` (`1280 × 720` px).
- Capture ciblée du panneau rempli : `C:\Users\oscar\.codex\worktrees\62b3\Macro\design-qa-artifacts\architect-project-navigator-populated.png` (`378 × 720` px).
- Comparaison côte à côte : `C:\Users\oscar\.codex\worktrees\62b3\Macro\design-qa-artifacts\navigator-comparison.png` (`756 × 720` px).
- Viewport du shell : `1280 × 720` CSS px, DPR `1,25`, capture normalisée par le navigateur en `1280 × 720` px.
- Viewport de la capture ciblée : `1280 × 720` CSS px avec un panneau fixé à `378` CSS px, DPR `1,25`, puis recadrage à `378 × 720` px.
- Normalisation de la source : recadrage du panneau à `378 × 720` px depuis `x=0`, `y=51`, sans redimensionnement ni changement de densité.
- État : thème sombre, deux groupes développés, dix plans, plan multi-projets actif et épinglé.

## Vérifications

### Vue complète

Le shell conserve les trois surfaces Macro : navigation à gauche, conversation au centre, stratégie à droite, avec un footer global unique. Le sélecteur de projet n'est plus dupliqué dans le header Architecte et le sélecteur de plan a disparu de l'en-tête central. Le viewport complet disponible diffère de celui de l'image générée ; les proportions ont donc été jugées dans le shell réel, puis le panneau a été comparé séparément à largeur identique.

### Région ciblée

La comparaison côte à côte confirme la même structure : titre et actions globales, section Épinglés, section Projets, un seul niveau projet puis plans, groupe actif, plan actif et actions contextuelles. La densité est volontairement plus compacte que l'image générée afin de suivre les primitives réelles de Macro (`text-xs`, hauteur d'en-tête de 48 px, rayons et couleurs du thème) et de satisfaire l'objectif d'afficher davantage de plans.

### Surfaces de fidélité requises

- Typographie : famille, graisse et antialiasing hérités du shell Macro ; hiérarchie claire entre titre, sections, projets et plans ; troncature prévue pour les noms longs.
- Espacement et rythme : en-tête aligné sur les autres panneaux, liste scrollable indépendante et indentation unique sans rail vertical ; aucune profondeur supplémentaire.
- Couleurs et jetons : uniquement les jetons Macro (`bg-card`, `border-border`, `text-muted-foreground`, `primary`, `accent`) ; contraste actif et focus visibles.
- Images et ressources : aucune image spécifique n'est requise ; les icônes proviennent de la bibliothèque déjà utilisée par Macro, sans dessin artisanal ni ressource de remplacement.
- Copie : libellés français accentués et traductions synchronisées pour les six langues prises en charge.

## Interactions et accessibilité testées

- Passage au mode Architecte et ouverture/fermeture du panneau gauche.
- Ouverture puis annulation du formulaire d'ajout de projet.
- Épinglage et désépinglage d'un plan.
- Ouverture du menu d'actions d'un plan et présence des actions autorisées.
- Séparateur exposé comme `role="separator"`, utilisable au clavier avec les flèches et un pas accéléré avec Maj.
- États vide, actif, épinglé, chargement et lecture seule couverts par le rendu ou les tests ciblés.
- Aucun avertissement ni erreur dans la console sur les captures finales.

## Historique de comparaison

1. Première passe : les actions d'un projet actif restaient masquées et le nombre de projets d'un plan était affiché sans contexte. Ces écarts étaient classés P2 car ils réduisaient la découvrabilité et ajoutaient du bruit.
2. Corrections : bouton de création toujours visible sur le projet actif, actions du plan actif visibles, suppression du compteur ambigu sur les lignes de plan, icône dossier alignée sur la référence et ajout du nombre de portées à la section Projets.
3. Seconde passe : aucun écart P0, P1 ou P2 restant. La densité plus forte que le rendu généré est intentionnelle et cohérente avec l'application réelle.
4. Passe d'usage : suppression des contours et des rails verticaux, conservation du repli sur les projets vides et remplacement de l'accordéon des archives par une vue dédiée accessible depuis le pied du panneau.

## Suivi de finition

- Passe de finition après usage réel : le navigateur héritait d'une largeur globale de `600 px`, adaptée à d'autres panneaux mais trop importante pour une arborescence. Le mode Architect utilise désormais une largeur dédiée de `320 px`, redimensionnable entre `260` et `420 px`.
- Les intitulés de section utilisent une casse naturelle, les actions globales restent discrètes, et les états « projet sélectionné » et « plan actif » sont visuellement distincts sans bordure d'accentuation.
- L'action « Créer le premier plan » conserve un contour pointillé comme repère visuel propre à l'état vide, sans réintroduire de cadre sur les lignes de navigation.
- Le type du plan est désormais écrit sur chaque ligne ; l'ancien point de cycle de vie, ambigu sans légende, a été retiré. Le bouton `+`, l'état vide et le clic droit ouvrent le même choix de type.
- Le clic droit d'un projet ou d'un plan expose les actions pertinentes déjà disponibles dans l'interface, avec les mêmes restrictions métier.
- L'accès aux archives est fixé en bas du panneau, comme dans le mode Chat. Il bascule vers une liste dédiée au lieu d'ajouter une section au milieu de l'arborescence active.
- Les points de statut exposent désormais leur libellé traduit. Le menu d'un plan se ferme au clic extérieur ou avec Échap, et une liste développée peut revenir à son état condensé.

final result: passed
