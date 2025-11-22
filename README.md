# Isotope - Variable Controller for Figma

Isotope is a powerful Figma plugin designed to streamline the management of local variables. It allows you to export your variables to various formats, import variables from JSON files, and bulk delete data, making it an essential tool for design system maintainers and developers.

## Features

- **Export Variables**: Export your local variables to multiple formats:
  - **Simplified JSON**: A clean, easy-to-read JSON format.
  - **Full Spec JSON**: Compliant with the W3C Design Tokens Community Group (DTCG) specification.
  - **CSS Variables**: Ready-to-use CSS custom properties.
  - **Tailwind Config**: A JavaScript configuration object for Tailwind CSS.

- **Import Variables**: Bulk create or update variables using a JSON file.
  - **Upsert Strategy**: Creates new collections/modes/variables if they don't exist, and updates values if they do.
  - **Alias Support**: Preserves variable references (aliases) during import.

- **Bulk Delete**: Quickly remove all local variables, collections, and modes to start fresh.

## Usage

### Exporting Variables

1. Open the Isotope plugin.
2. In the **Export** section, select your desired format (Simplified, Full Spec, CSS, or Tailwind).
3. Click **Export Variables**.
4. Save the generated file to your computer.

### Importing Variables

1. Open the Isotope plugin.
2. In the **Import** section, click **Import Variables**.
3. Select a valid JSON file containing your variable definitions.
4. The plugin will process the file and report progress.

### Deleting Data

1. Click the **Delete all data** link in the footer.
2. Confirm the action in the modal dialog.
3. **Warning**: This action is irreversible and will remove ALL local variables in the file.

## JSON Format Specification

Isotope supports a hierarchical JSON structure compatible with the W3C Design Tokens format.

### Structure

```json
{
  "Collection Name": {
    "Mode Name": {
      "Group": {
        "Variable": { 
          "$type": "color", 
          "$value": "#FF0000" 
        }
      }
    }
  }
}
```

### Supported Types

- **color**: Hex codes (e.g., `#FF0000`)
- **number**: Numeric values (e.g., `16`, `0.5`)
- **boolean**: `true` or `false`
- **string**: Text values

### Aliases

To reference another variable, use the syntax `{Collection.Group.Variable}`.
Example: `"$value": "{Brand.Color.Primary}"`

## Development

This plugin is built with TypeScript and NPM.

### Prerequisites

- [Node.js](https://nodejs.org/en/download/)
- NPM (comes with Node.js)

### Setup

1. Clone the repository.
2. Install dependencies:

   ```bash
   npm install
   ```

### Building

To compile the TypeScript code to JavaScript:

```bash
npm run build
```

To watch for changes during development:

```bash
npm run watch
```

## License

MIT
