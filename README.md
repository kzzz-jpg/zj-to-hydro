# @ddj-v2/zj-to-hydro

A tool designed to convert problem data from ZeroJudge (ZJSON) format to HydroOJ compatible format. It simplifies the migration process by automatically handling complex formatting and LaTeX expressions.

## Installation

You can install the package via npm by running the following command in your terminal:

```bash
yarn global add @ddj-v2/zj-to-hydro
hydrooj addon add @ddj-v2/zj-to-hydro
```

## Features

* **Seamless Conversion**: Transition your problems from ZeroJudge to HydroOJ with ease.
* **Format Support**: Upload your data in either .zjson or .zip format.
    * Note: Currently supports single file upload at a time.
* **Rich Content Support**: The converter intelligently handles:
    * Markdown: Headers, Bold, Italic, Strikethrough, and Underline.
    * Mathematics: Full support for LaTeX / KaTeX (inline and display mode).
    * Layouts: Tables, lists, and horizontal rules.
    * Media: Image embedding and link preservation.
* **Automatic Author Linking**: Automatically generates a link to the author's profile on the original platform (DanDanJudge).

## Limitations

* **Custom Colors**: CSS-based custom text colors are currently not supported and will be rendered as plain text or default style.
* **Upload Size**: For files larger than 15MB, it is highly recommended to compress them into a .zip file before uploading to ensure better efficiency and stability.

## Usage

1. Navigate to the Import Problem section in your HydroOJ administration panel.
2. Select the From JSON/ZIP Export option.
3. Upload your .zjson file or a .zip containing the problem data.

## Contributing

Contributions are what make the open-source community an amazing place to learn, inspire, and create. Any contributions you make are greatly appreciated.

* **Report Bugs**: If you find a bug, please open an issue on GitHub.
* **Feature Requests**: Have an idea to make this tool better? Feel free to open an issue or submit a Pull Request.

**GitHub Repository**: [https://github.com/ddj-v2/zj-to-hydro](https://github.com/ddj-v2/zj-to-hydro)

## License

Distributed under the MIT License. See LICENSE for more information.
