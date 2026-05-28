// Header template for generated applications
// Provides a reusable Angular component header structure

export const generateHeaderTemplate = (componentName: string = 'HeaderComponent'): string => {
  return `
// Angular component header
import { Component } from '@angular/core';

@Component({
  selector: 'app-${componentName.toLowerCase()}',
  templateUrl: './${componentName}.component.html',
  styleUrls: ['./${componentName}.component.css']
})
export class ${componentName} {
  title = 'Generated App Header';
}
`;
};

// Default header template with standard component name
export const headerTemplate = generateHeaderTemplate('HeaderComponent');
