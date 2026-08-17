export default function (eleventyConfig) {
  // Mirrored CSS/JS/images and CMS uploads are served as-is.
  eleventyConfig.addPassthroughCopy("assets");
  eleventyConfig.addPassthroughCopy({ admin: "admin" });

  // Webflow's markup is emitted verbatim, so nothing here should be
  // transformed or prettified - byte fidelity is the whole point.
  eleventyConfig.setLiquidOptions({ jsTruthy: true });

  return {
    dir: {
      input: "src",
      output: "_site",
      includes: "_includes",
      data: "_data",
    },
    htmlTemplateEngine: "njk",
    markdownTemplateEngine: "njk",
    templateFormats: ["njk"],
  };
}
