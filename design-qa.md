# QA visuelle — bandeau de dictée

- Vérité visuelle source : `C:\Users\oscar\AppData\Local\Temp\codex-clipboard-3e1185c9-3895-41fa-846e-577acce7a539.png`
- Capture complète de l’implémentation : `C:\Users\oscar\.codex\visualizations\2026\08\14\01a0012a-4aff-70d3-aff1-b4f330065a0e\speech-recording-implementation-full-final.png`
- Capture rapprochée de l’implémentation : `C:\Users\oscar\.codex\visualizations\2026\08\14\01a0012a-4aff-70d3-aff1-b4f330065a0e\speech-recording-implementation-focused-final.png`
- État : enregistrement actif à 0:06, thème sombre, actions « arrêter et insérer » et « arrêter et envoyer » disponibles.
- Viewport : 1280 × 720 CSS px, `devicePixelRatio` 1,25.
- Dimensions : source 926 × 80 px ; composant 920 × 49,6 CSS px ; capture rapprochée 920 × 50 px. La différence de hauteur est intentionnelle : le bandeau remplace le composer Macro sans augmenter sa hauteur.

## Comparaison complète

Le bandeau conserve la largeur et la densité du composer Macro. La hiérarchie correspond à la référence : onde dominante, durée tabulaire, arrêt secondaire, envoi primaire. Les tokens de fond, bordure, premier plan et couleur primaire restent ceux du thème Macro. Les boutons utilisent volontairement les coins arrondis existants de Macro, conformément au retour utilisateur, plutôt que les pastilles circulaires de la référence.

## Comparaison rapprochée

- Typographie : durée compacte, lisible et alignée ; aucun autre texte visible ne surcharge l’état d’enregistrement.
- Espacement : onde flexible, durée stable et actions de 36 px ; aucun décalage vertical ni débordement.
- Couleurs : contraste conforme aux tokens du thème ; l’action d’envoi reste immédiatement identifiable.
- Qualité visuelle : onde rendue sur canvas à partir du niveau réel du microphone, nette à la densité courante.
- Copie : les libellés accessibles distinguent explicitement l’insertion de l’envoi immédiat.
- Icônes : icônes Lucide partagées par Macro ; aucun dessin ou glyphe approximatif.

## Historique des corrections

1. Première passe — bloquée : la largeur intrinsèque du canvas augmentait au fil des images et pouvait repousser la durée et les actions hors du composer (P1).
2. Correction : ajout d’une base de largeur nulle au canvas flexible pour empêcher sa résolution interne haute densité d’influencer le calcul Flexbox.
3. Nouvelle capture après 2,2 secondes d’animation : canvas de 763,4 px dans un bandeau de 920 px ; les deux boutons restent à l’intérieur, sans erreur console.
4. Retour utilisateur intégré : remplacement des boutons circulaires par les boutons `rounded-lg` habituels de Macro. Aucun P0, P1 ou P2 restant.

## Interactions vérifiées

- Arrêter déclenche la transcription avec l’intention d’insérer le texte dans le brouillon.
- Envoyer déclenche la transcription avec l’intention d’insérer au curseur puis d’envoyer immédiatement le texte composé.
- Les deux actions sont verrouillées pendant le traitement et l’action choisie affiche sa progression.
- Les tests automatisés vérifient les deux intentions, les styles des boutons et la conservation du texte au curseur.
- Aucune erreur console sur la passe finale rendue dans le navigateur.

final result: passed

---

# QA visuelle — badge projet des cartes de tâches

## Références et état comparé

- Vérité visuelle source : `C:\Users\oscar\AppData\Local\Temp\codex-clipboard-eaf576e6-43aa-4e3e-8898-de0b06822054.png` (`576 × 189` px).
- Capture complète : `C:\Users\oscar\.codex\visualizations\2026\08\14\01a0012a-4aff-70d3-aff1-b4f330065a0e\task-project-badge\implementation-full.png` (`567 × 500` px).
- Capture ciblée : `C:\Users\oscar\.codex\visualizations\2026\08\14\01a0012a-4aff-70d3-aff1-b4f330065a0e\task-project-badge\implementation-focus.png` (`567 × 165` px).
- Comparaison combinée : `C:\Users\oscar\.codex\visualizations\2026\08\14\01a0012a-4aff-70d3-aff1-b4f330065a0e\task-project-badge\comparison.png` (`1134 × 190` px).
- Cas étroit avec nom long : `C:\Users\oscar\.codex\visualizations\2026\08\14\01a0012a-4aff-70d3-aff1-b4f330065a0e\task-project-badge\implementation-narrow-long-project.jpg` (`320 × 500` px).
- Viewports CSS : `567 × 500`, puis `320 × 500`; DPR `1,25`. La capture ciblée a été recadrée sans redimensionnement. La source a été recadrée à `567` px de large pour la planche comparative.
- État : thème sombre, tâche Architecte prête, projet primaire « Andrologic », plan « Refonte du site ».

## Vérifications

Le badge projet apparaît en première position, avant le badge de plan. Son icône `folder-git-2` reprend l’iconographie projet existante de Macro. Le footer reste sur une ligne et la carte conserve sa hauteur fixe de `112` px.

La comparaison focalisée valide les cinq surfaces de fidélité : typographie identique aux badges existants ; espacement, padding et rayon cohérents ; tokens de couleurs réutilisés ; icône Lucide nette sans asset approximatif ; nom réel du projet primaire avec libellé complet dans `title`. À `320` px, un nom volontairement long et le badge de plan restent tous deux visibles et se tronquent sans débordement.

- Aucun écart P0, P1 ou P2.
- Aucun avertissement ni erreur de console.
- Historique : premier passage nominal réussi ; second passage étroit avec nom long réussi, sans correction intermédiaire.
- Vérifications fonctionnelles : badge omis si le projet primaire manque ; une tâche multi-projets n’affiche que son projet primaire ; ordre des badges couvert par les tests.

final result: passed

---

# Archive QA visuelle — navigation Architecte

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

---

# Design QA — centrage de la fenêtre « Ajouter un projet »

- Vérité visuelle source : `C:/Users/oscar/AppData/Local/Temp/codex-clipboard-486b7d13-afed-40d7-980d-3473b4b864c2.png`
- Capture de l’implémentation : `docs/design-qa/project-modal-centered.png`
- État comparé : fenêtre « Ajouter un projet » ouverte, thème sombre, projet non sélectionné.
- Source : 3439 × 1372 px, densité inconnue.
- Implémentation : viewport CSS 1280 × 720, capture 1280 × 720 px, `devicePixelRatio = 1.25`.

**Findings**

- Aucun écart P0, P1 ou P2 restant.
- Typographie : famille, graisse, taille, hauteur de ligne et hiérarchie inchangées par rapport au composant existant.
- Espacement et rythme : carte de 620 px centrée exactement dans le viewport ; erreur mesurée de 0 px sur les axes horizontal et vertical. Les marges de sécurité du fond restent intactes.
- Couleurs et tokens : fond, bordures, ombre, opacité du backdrop et couleurs sémantiques inchangés.
- Images et icônes : aucune ressource visuelle n’a été remplacée ou altérée.
- Contenu : libellés, champs, onglets et actions inchangés.

**Full-view comparison evidence**

- La source montre la carte alignée à environ 20 px du bord gauche du viewport.
- La capture corrigée montre la même carte au centre de la zone assombrie.
- Mesures après correction : viewport 1280 × 720 ; carte `x = 330`, `y = 124.8`, largeur `620`, hauteur `470.4` ; centre de la carte `640 × 360`, identique au centre du viewport.

**Focused region comparison evidence**

- Aucun recadrage supplémentaire n’était nécessaire : la seule différence attendue concerne la composition globale et les limites de la carte sont entièrement lisibles dans les deux captures.

**Comparison history**

1. Avant correction — P1 : le panneau sémantique du dialogue occupait toute la largeur et son enfant à largeur maximale restait aligné à gauche.
2. Correctif — le panneau partagé `Dialog` utilise désormais un conteneur flex centré pour ses enfants lorsque le consommateur ne fournit pas sa propre classe de panneau.
3. Après correction — centre horizontal et vertical mesuré à 0 px d’écart ; onglets et fermeture testés ; aucune erreur ou aucun avertissement dans la console.

**Implementation Checklist**

- [x] Centrer les cartes de dialogue utilisant le panneau partagé par défaut.
- [x] Préserver les dialogues qui fournissent leur propre `panelClassName`.
- [x] Ajouter une assertion de régression ciblée.
- [x] Vérifier les interactions principales et la console dans le navigateur intégré.

**Follow-up Polish**

- Aucun suivi nécessaire pour cette correction.

final result: passed
