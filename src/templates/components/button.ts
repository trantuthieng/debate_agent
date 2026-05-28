// Button component template
// A reusable button component for Angular applications

export const buttonTemplate = `
// Button Component
import { Component, Input } from '@angular/core';

@Component({
  selector: 'app-button',
  templateUrl: './button.component.html',
  styleUrls: ['./button.component.css']
})
export class ButtonComponent {
  /**
   * Button label
   * @default 'Click Me'
   */
  @Input() label = 'Click Me';
}
`;
