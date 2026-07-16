/** Brand name shown in the UI. Single source: never "Bramblekeep" hardcoded
 * elsewhere (the product may be renamed). i18n strings inject it via the
 * `{{app}}` interpolation (global default set at i18next init), TSX code via
 * this constant. No dependencies: keeps renaming trivial. */
export const APP_NAME = "Bramblekeep";
