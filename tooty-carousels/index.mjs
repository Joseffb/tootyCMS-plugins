export async function register(_kernel, api) {
  api.registerContentType({
    key: "carousel",
    label: "Carousel",
    description: "Carousel entries used by themes to render panel-based sliders.",
    showInMenu: false,
  });
}
