# Design Guidelines for ship.jerky.com

## Design Approach
**System-Based with jerky_top_n_web Theme Integration**
This is a utility-focused fulfillment tool requiring clarity and efficiency. We'll adapt jerky_top_n_web's warm, approachable aesthetic while prioritizing readability and scannability for warehouse environments.

## Core Design Principles
- **Readability First**: Large text, high contrast, minimal decoration
- **Single-Purpose Screens**: Each view focuses on one task (search orders, view order details, print)
- **Warehouse-Optimized**: Design for varying lighting conditions and quick scanning
- **Familiar Authentication**: Maintain jerky_top_n_web's trusted login experience

---

## Color System
Inherit jerky_top_n_web's warm earth tone palette:

**Primary Colors**:
- Background: `#f5f3ed` (warm cream)
- Primary Green: `#6B8E23` (olive)
- Accent Brown: `#8B4513` (saddle brown)
- Text: `#2c2c2c` (near black)
- Secondary Text: `#666666`

**UI Elements**:
- Card backgrounds: `#ffffff`
- Borders: `#e0e0e0`
- Success states: `#2e7d32` (green)
- Error states: `#c62828` (red)
- Warning: `#f5c518` (gold)

---

## Typography

**Font Families**:
- Headings: Georgia, serif (matches jerky_top_n_web)
- Body: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif

**Type Scale for Warehouse Readability**:
- H1 (Page Titles): 36px, bold
- H2 (Section Headers): 28px, bold
- H3 (Card Headers): 24px, semibold
- Order Numbers: 32px, bold, monospace (for scanning)
- Customer Names: 24px, semibold
- Product Names: 20px, medium
- Body/Labels: 16px, regular
- Small/Meta: 14px, regular

---

## Layout System

**Spacing Units**: Use Tailwind spacing - `p-4`, `p-6`, `p-8`, `gap-4`, `gap-6`
- Consistent rhythm with 4px base unit
- Generous whitespace for clarity (minimum `p-6` on cards)

**Container Widths**:
- Dashboard/List Views: `max-w-7xl` (wide for multiple columns)
- Order Detail View: `max-w-6xl` (centered, focused)
- Forms/Profile: `max-w-2xl` (narrow, focused)

**Grid Layouts**:
- Order List: Single column on mobile, 2-column on desktop
- Product Grid (within order): 2-column responsive layout with large product cards

---

## Component Library

### Navigation & Header
- **Header**: White background, subtle shadow, contains logo and user avatar
- **Logo**: Left-aligned, matches jerky_top_n_web branding
- **User Menu**: Right-aligned avatar (circular, 40px) with dropdown for profile/logout

### Authentication
- **Login Page**: Centered card (520px max-width) with magic link form
- **Email Input**: Large (16px text), 2px borders, olive green focus state
- **Submit Button**: Full-width, olive green (#6B8E23), bold text, subtle shadow

### Profile Page
- **Avatar Section**: Large circular avatar (120px), upload/crop functionality
- **Handle Input**: "@" prefix, inline generation button, live validation
- **Form Controls**: White cards with generous padding (p-8)

### Order Dashboard
- **Search Bar**: Prominent at top, large input field with search icon
- **Filter Pills**: Horizontal row of status filters (All, Pending, Fulfilled)
- **Order Cards**: White cards with shadow, display order number (large, monospace), customer name, status badge

### Order Detail View (Primary Focus)
**Layout**: Single-column, print-optimized

**Customer Section** (top priority):
- Large heading: "Customer Information"
- Name: 24px, bold
- Address: 18px, line-separated for clarity
- Phone/Email: 18px with icons

**Products Section**:
- Grid of product cards (2-column on desktop)
- Each card shows:
  - Product image (large, 200px square)
  - Product name (20px, bold)
  - SKU (18px, monospace)
  - Quantity (24px, highlighted with background)

**Actions**:
- Large "Print Packing Slip" button (olive green)
- Secondary "Print Label" button (brown)

### Print Styles
- Hide navigation, buttons, and UI chrome
- Black text on white background
- Enlarge text for label printers
- Add page breaks between sections

---

## Interaction Patterns

**Buttons**:
- Primary: Olive green background, white text, 8px border radius, shadow
- Secondary: White background, olive border, olive text
- Hover: Darken by 15%
- No custom states for buttons on images

**Cards**:
- White background
- Border radius: 12px
- Shadow: `0 4px 20px rgba(0,0,0,0.08)`
- Hover: Subtle shadow increase

**Forms**:
- Input focus: 2px olive green border
- Labels: 14px, semibold, above inputs
- Validation: Inline messages with color-coded icons

---

## Images

**Where to Use Images**:
1. **Product Images**: Within order detail cards (200px square, object-fit: cover)
2. **User Avatars**: Profile page and navigation (circular crop)
3. **No Hero Image**: This is a utility app - go straight to functionality

**Image Specifications**:
- Product images: Square aspect ratio, high resolution for print
- Avatars: 512x512px recommended, cropped to circle

---

## Accessibility

- Minimum 4.5:1 contrast ratio for all text
- 44px minimum touch targets for buttons
- Clear focus indicators (olive green outline)
- Semantic HTML structure for screen readers
- Print styles maintain readability

---

## Key Screens

1. **Login**: Centered magic link form, matching jerky_top_n_web exactly
2. **Dashboard**: Order search + filtered list of order cards
3. **Order Detail**: Large-format customer info + product grid + print buttons
4. **Profile**: Avatar upload/crop + handle generation + account details