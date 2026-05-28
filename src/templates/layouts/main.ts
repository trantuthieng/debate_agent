// Main layout template for generated applications
// This template provides a structured foundation for the application layout

export const mainLayoutTemplate = `
// Main Layout Component
// Provides the primary structure for the application
import { Component } from '@angular/core';

@Component({
  selector: 'app-main-layout',
  templateUrl: './main-layout.component.html',
  styleUrls: ['./main-layout.component.css']
})
export class MainLayoutComponent {
  // Component logic and properties would be defined here
  // Example: currentPage: string = 'home';
}

// HTML Template Structure
// This would be in main-layout.component.html
// <div class="main-layout">
//   <header>
//     <app-header></app-header>
//   </header>
//   <main>
//     <router-outlet></router-outlet>
//   </main>
//   <footer>
//     <app-footer></app-footer>
//   </footer>
// </div>

// CSS Styling
// This would be in main-layout.component.css
// .main-layout {
//   display: flex;
//   flex-direction: column;
//   min-height: 100vh;
// }
// header, main, footer {
//   flex: 1;
// }
`;
