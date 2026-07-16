-- UI language preference. Additive, defaults to English. Set at onboarding and in
-- settings; the frontend also caches it in localStorage for a flash-free boot.
ALTER TABLE users ADD COLUMN language TEXT NOT NULL DEFAULT 'en';
