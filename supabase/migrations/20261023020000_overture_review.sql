-- Review annotations do not edit any original feature or merge branches.
insert into private.overture_review(id,status,reason,evidence) values
('438d9378-8f63-494e-95d4-d91c2569d69a','exclude','Adresse actuelle officielle à Sainte-Anne-des-Plaines, point publié à Laval : conflit non résolu','["https://www.constructionmatteau.com/"]'),
('b4135484-6820-4310-b79e-ff14de956a2f','review','Huot & Huot annonce son intégration à Tris Coffin : identité et emplacement à revoir, aucune fusion automatique','["https://www.triscoffin.com/huotethuot/"]'),
('f7ae806e-c9ab-485f-98c6-7f40334515c3','review','Adresse et téléphone de la fiche différents du contact officiel actuel ; ancienne implantation non résolue','["https://groupemontoni.com/fr/nous-joindre"]'),
('4c7d742f-41b9-4b24-a5fd-66f6f94752c1','review','Code postal J0S 1V0 et point à Québec : incohérence suspectée, pas de preuve primaire suffisante pour corriger','["http://toituresjms.com/"]'),
('abdc874e-2879-4d53-a035-a182f427bd1a','review','Ordre professionnel, pas une clinique : adéquation au secteur commercial non démontrée','["https://www.maboucheensante.com/"]'),
('ba225f98-3d12-4c34-881f-b42560988e65','review','Laboratoire universitaire, lien source vers une autre chercheuse : ne pas traiter comme clinique indépendante','["https://proteo.ca/equipes-de-recherche/amelie-fradet-turcotte/"]')
on conflict(id) do update set status=excluded.status,reason=excluded.reason,evidence=excluded.evidence,reviewed_at=now();
delete from private.overture_cache;
