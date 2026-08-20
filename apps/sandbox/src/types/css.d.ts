// tsgo (unlike tsc with Next's bundler resolution) checks side-effect CSS
// imports; declare them so `import "./globals.css"` typechecks.
declare module "*.css";
