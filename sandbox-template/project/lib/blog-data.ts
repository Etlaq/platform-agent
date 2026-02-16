export interface BlogPost {
  id: string;
  slug: string;
  title: {
    ar: string;
    en: string;
  };
  excerpt: {
    ar: string;
    en: string;
  };
  content: {
    ar: string;
    en: string;
  };
  date: string;
  author: {
    name: string;
    avatar?: string;
  };
  coverImage: string;
  readTime: number;
}

export const blogPosts: BlogPost[] = [
  {
    id: '1',
    slug: 'getting-started-with-nextjs-16',
    title: {
      ar: 'البدء مع Next.js 16: دليل شامل',
      en: 'Getting Started with Next.js 16: A Comprehensive Guide'
    },
    excerpt: {
      ar: 'اكتشف الميزات الجديدة في Next.js 16 وكيفية استخدامها لبناء تطبيقات ويب حديثة وسريعة.',
      en: 'Discover the new features in Next.js 16 and how to use them to build modern, fast web applications.'
    },
    content: {
      ar: `# البدء مع Next.js 16

Next.js 16 هو أحدث إصدار من إطار العمل الشهير من Vercel، ويأتي مع العديد من الميزات الجديدة والتحسينات.

## الميزات الرئيسية

### 1. تحسينات الأداء
- تحسينات في سرعة التحميل
- تحسينات في Server Components
- تحسينات في التخزين المؤقت

### 2. App Router المحسّن
- دعم أفضل للـ Server Actions
- تحسينات في التوجيه
- دعم أفضل للـ Streaming

### 3. TypeScript محسّن
- دعم أفضل للأنواع
- تحسينات في IntelliSense
- تحسينات في الأداء

## البدء

للبدء مع Next.js 16، يمكنك إنشاء مشروع جديد:

\`\`\`bash
npx create-next-app@latest my-blog
\`\`\`

ثم اختر الخيارات المناسبة لمشروعك.

## الخاتمة

Next.js 16 هو إصدار رائع يجلب العديد من التحسينات والميزات الجديدة. ننصحك بتجربته في مشاريعك القادمة.`,
      en: `# Getting Started with Next.js 16

Next.js 16 is the latest version of the popular framework from Vercel, and it comes with many new features and improvements.

## Key Features

### 1. Performance Improvements
- Faster load times
- Improved Server Components
- Better caching

### 2. Enhanced App Router
- Better Server Actions support
- Improved routing
- Better streaming support

### 3. Improved TypeScript
- Better type support
- Improved IntelliSense
- Performance improvements

## Getting Started

To get started with Next.js 16, you can create a new project:

\`\`\`bash
npx create-next-app@latest my-blog
\`\`\`

Then choose the options that suit your project.

## Conclusion

Next.js 16 is a great release that brings many improvements and new features. We recommend trying it in your next projects.`
    },
    date: '2024-01-15',
    author: {
      name: 'أحمد محمد',
      avatar: 'https://ui-avatars.com/api/?name=Ahmed+Mohammed&background=0D8ABC&color=fff'
    },
    coverImage: 'https://images.unsplash.com/photo-1633356122544-f134324a6cee?w=800&h=400&fit=crop',
    readTime: 5
  },
  {
    id: '2',
    slug: 'tailwind-css-4-best-practices',
    title: {
      ar: 'أفضل ممارسات Tailwind CSS 4',
      en: 'Tailwind CSS 4 Best Practices'
    },
    excerpt: {
      ar: 'تعلم أفضل الممارسات والأنماط لاستخدام Tailwind CSS 4 في مشاريعك القادمة.',
      en: 'Learn the best practices and patterns for using Tailwind CSS 4 in your next projects.'
    },
    content: {
      ar: `# أفضل ممارسات Tailwind CSS 4

Tailwind CSS 4 هو أحدث إصدار من إطار العمل CSS الشهير، ويأتي مع العديد من التحسينات والميزات الجديدة.

## الميزات الجديدة

### 1. محرك CSS جديد
- أداء أسرع
- حجم أصغر
- دعم أفضل للميزات الحديثة

### 2. تحسينات في التخصيص
- تخصيص أسهل
- دعم أفضل للثيمات
- تكامل أفضل مع الأدوات

## أفضل الممارسات

### 1. استخدام الألوان الدلالية
بدلاً من استخدام ألوان ثابتة، استخدم الألوان الدلالية:

\`\`\`html
<div class="bg-background text-foreground">
\`\`\`

### 2. دعم RTL
استخدم فئات RTL-safe:

\`\`\`html
<div class="ps-4 pe-4">
\`\`\`

### 3. التصميم المتجاوب
استخدم فئات التجاوب:

\`\`\`html
<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
\`\`\`

## الخاتمة

Tailwind CSS 4 هو تحسين كبير على الإصدارات السابقة. اتبع هذه الممارسات للحصول على أفضل النتائج.`,
      en: `# Tailwind CSS 4 Best Practices

Tailwind CSS 4 is the latest version of the popular CSS framework, and it comes with many improvements and new features.

## New Features

### 1. New CSS Engine
- Faster performance
- Smaller size
- Better support for modern features

### 2. Improved Customization
- Easier customization
- Better theme support
- Better tool integration

## Best Practices

### 1. Use Semantic Colors
Instead of using fixed colors, use semantic colors:

\`\`\`html
<div class="bg-background text-foreground">
\`\`\`

### 2. RTL Support
Use RTL-safe classes:

\`\`\`html
<div class="ps-4 pe-4">
\`\`\`

### 3. Responsive Design
Use responsive classes:

\`\`\`html
<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
\`\`\`

## Conclusion

Tailwind CSS 4 is a significant improvement over previous versions. Follow these practices for the best results.`
    },
    date: '2024-01-10',
    author: {
      name: 'سارة أحمد',
      avatar: 'https://ui-avatars.com/api/?name=Sara+Ahmed&background=E91E63&color=fff'
    },
    coverImage: 'https://images.unsplash.com/photo-1507721999472-8ed4421c4af2?w=800&h=400&fit=crop',
    readTime: 4
  },
  {
    id: '3',
    slug: 'building-accessible-web-apps',
    title: {
      ar: 'بناء تطبيقات ويب متاحة للجميع',
      en: 'Building Accessible Web Applications'
    },
    excerpt: {
      ar: 'دليل شامل لبناء تطبيقات ويب متاحة وسهلة الاستخدام لجميع المستخدمين.',
      en: 'A comprehensive guide to building accessible and user-friendly web applications for all users.'
    },
    content: {
      ar: `# بناء تطبيقات ويب متاحة للجميع

إمكانية الوصول (Accessibility) هي جانب مهم من تطوير الويب يضمن أن جميع المستخدمين يمكنهم استخدام تطبيقك.

## مبادئ إمكانية الوصول

### 1. قابلية الإدراك
- توفير بدائل نصية للصور
- استخدام ألوان ذات تباين كافٍ
- توفير تسميات واضحة

### 2. قابلية التشغيل
- دعم التنقل بلوحة المفاتيح
- توفير وقت كافٍ للتفاعل
- تجنب المحتوى الذي يسبب نوبات

### 3. قابلية الفهم
- استخدام لغة واضحة وبسيطة
- توفير تعليمات واضحة
- تجنب الأخطاء الشائعة

## أفضل الممارسات

### 1. HTML الدلالي
استخدم عناصر HTML الدلالية:

\`\`\`html
<nav aria-label="Main navigation">
  <ul>
    <li><a href="/">Home</a></li>
  </ul>
</nav>
\`\`\`

### 2. ARIA Labels
استخدم سمات ARIA عند الحاجة:

\`\`\`html
<button aria-label="Close menu">×</button>
\`\`\`

### 3. التركيز
تأكد من أن جميع العناصر التفاعلية قابلة للتركيز:

\`\`\`css
:focus-visible {
  outline: 2px solid blue;
}
\`\`\`

## الخاتمة

بناء تطبيقات متاحة للجميع ليس فقط مسألة قانونية، بل هو أيضًا ممارسة جيدة تؤدي إلى تجربة مستخدم أفضل للجميع.`,
      en: `# Building Accessible Web Applications

Accessibility is an important aspect of web development that ensures all users can use your application.

## Accessibility Principles

### 1. Perceivable
- Provide text alternatives for images
- Use colors with sufficient contrast
- Provide clear labels

### 2. Operable
- Support keyboard navigation
- Provide enough time for interaction
- Avoid content that causes seizures

### 3. Understandable
- Use clear and simple language
- Provide clear instructions
- Avoid common errors

## Best Practices

### 1. Semantic HTML
Use semantic HTML elements:

\`\`\`html
<nav aria-label="Main navigation">
  <ul>
    <li><a href="/">Home</a></li>
  </ul>
</nav>
\`\`\`

### 2. ARIA Labels
Use ARIA attributes when needed:

\`\`\`html
<button aria-label="Close menu">×</button>
\`\`\`

### 3. Focus
Ensure all interactive elements are focusable:

\`\`\`css
:focus-visible {
  outline: 2px solid blue;
}
\`\`\`

## Conclusion

Building accessible applications is not only a legal requirement, but also a good practice that leads to a better user experience for everyone.`
    },
    date: '2024-01-05',
    author: {
      name: 'محمد علي',
      avatar: 'https://ui-avatars.com/api/?name=Mohammed+Ali&background=4CAF50&color=fff'
    },
    coverImage: 'https://images.unsplash.com/photo-1573164713714-d95e436ab8d6?w=800&h=400&fit=crop',
    readTime: 6
  },
  {
    id: '4',
    slug: 'modern-react-patterns-2024',
    title: {
      ar: 'أنماط React الحديثة لعام 2024',
      en: 'Modern React Patterns for 2024'
    },
    excerpt: {
      ar: 'استكشف أحدث أنماط React وممارسات التطوير التي يجب عليك معرفتها في عام 2024.',
      en: 'Explore the latest React patterns and development practices you should know in 2024.'
    },
    content: {
      ar: `# أنماط React الحديثة لعام 2024

React يتطور باستمرار، وهناك أنماط جديدة وممارسات يجب عليك معرفتها.

## الأنماط الرئيسية

### 1. Server Components
استخدم Server Components لتحسين الأداء:

\`\`\`tsx
async function BlogPost({ id }: { id: string }) {
  const post = await getPost(id);
  return <article>{post.content}</article>;
}
\`\`\`

### 2. Custom Hooks
أنشئ hooks قابلة لإعادة الاستخدام:

\`\`\`tsx
function useWindowSize() {
  const [size, setSize] = useState({ width: 0, height: 0 });
  // ...
  return size;
}
\`\`\`

### 3. Compound Components
استخدم نمط المكونات المركبة:

\`\`\`tsx
<Card>
  <Card.Header>Title</Card.Header>
  <Card.Body>Content</Card.Body>
</Card>
\`\`\`

## أفضل الممارسات

### 1. TypeScript
استخدم TypeScript لتحسين جودة الكود:

\`\`\`tsx
interface Props {
  title: string;
  count: number;
}
\`\`\`

### 2. Performance
تحسين الأداء باستخدام memo و useMemo:

\`\`\`tsx
const ExpensiveComponent = memo(({ data }) => {
  const processed = useMemo(() => processData(data), [data]);
  return <div>{processed}</div>;
});
\`\`\`

## الخاتمة

React في عام 2024 يوفر أدوات وأنماط قوية لبناء تطبيقات حديثة. استمر في التعلم والتجربة.`,
      en: `# Modern React Patterns for 2024

React is constantly evolving, and there are new patterns and practices you should know.

## Key Patterns

### 1. Server Components
Use Server Components for better performance:

\`\`\`tsx
async function BlogPost({ id }: { id: string }) {
  const post = await getPost(id);
  return <article>{post.content}</article>;
}
\`\`\`

### 2. Custom Hooks
Create reusable hooks:

\`\`\`tsx
function useWindowSize() {
  const [size, setSize] = useState({ width: 0, height: 0 });
  // ...
  return size;
}
\`\`\`

### 3. Compound Components
Use the compound components pattern:

\`\`\`tsx
<Card>
  <Card.Header>Title</Card.Header>
  <Card.Body>Content</Card.Body>
</Card>
\`\`\`

## Best Practices

### 1. TypeScript
Use TypeScript for better code quality:

\`\`\`tsx
interface Props {
  title: string;
  count: number;
}
\`\`\`

### 2. Performance
Optimize performance with memo and useMemo:

\`\`\`tsx
const ExpensiveComponent = memo(({ data }) => {
  const processed = useMemo(() => processData(data), [data]);
  return <div>{processed}</div>;
});
\`\`\`

## Conclusion

React in 2024 provides powerful tools and patterns for building modern applications. Keep learning and experimenting.`
    },
    date: '2024-01-01',
    author: {
      name: 'فاطمة حسن',
      avatar: 'https://ui-avatars.com/api/?name=Fatima+Hassan&background=9C27B0&color=fff'
    },
    coverImage: 'https://images.unsplash.com/photo-1633356122102-3fe601e05bd2?w=800&h=400&fit=crop',
    readTime: 7
  },
  {
    id: '5',
    slug: 'optimizing-nextjs-performance',
    title: {
      ar: 'تحسين أداء Next.js: نصائح وحيل',
      en: 'Optimizing Next.js Performance: Tips and Tricks'
    },
    excerpt: {
      ar: 'تعلم كيفية تحسين أداء تطبيقات Next.js الخاصة بك للحصول على أسرع تجربة مستخدم.',
      en: 'Learn how to optimize your Next.js applications for the fastest user experience.'
    },
    content: {
      ar: `# تحسين أداء Next.js: نصائح وحيل

الأداء هو جانب حاسم من أي تطبيق ويب. إليك كيفية تحسين أداء Next.js.

## استراتيجيات التحسين

### 1. تحسين الصور
استخدم مكون Image من Next.js:

\`\`\`tsx
import Image from 'next/image';

<Image
  src="/hero.jpg"
  alt="Hero"
  width={800}
  height={400}
  priority
/>
\`\`\`

### 2. التخزين المؤقت
استخدم revalidate للتحكم في التخزين المؤقت:

\`\`\`tsx
export const revalidate = 3600; // 1 hour
\`\`\`

### 3. تحميل الكود
استخدم dynamic imports:

\`\`\`tsx
const HeavyComponent = dynamic(() => import('./HeavyComponent'), {
  loading: () => <Skeleton />,
});
\`\`\`

## أدوات التحليل

### 1. Lighthouse
استخدم Lighthouse لتحليل الأداء:

\`\`\`bash
npm run lighthouse
\`\`\`

### 2. Web Vitals
تتبع Core Web Vitals:

\`\`\`tsx
'use client';
import { useReportWebVitals } from 'next/web-vitals';

export function WebVitals() {
  useReportWebVitals((metric) => {
    console.log(metric);
  });
  return null;
}
\`\`\`

## الخاتمة

تحسين الأداء هو عملية مستمرة. استخدم هذه النصائح لتحسين تطبيقات Next.js الخاصة بك.`,
      en: `# Optimizing Next.js Performance: Tips and Tricks

Performance is a crucial aspect of any web application. Here's how to optimize Next.js performance.

## Optimization Strategies

### 1. Image Optimization
Use Next.js Image component:

\`\`\`tsx
import Image from 'next/image';

<Image
  src="/hero.jpg"
  alt="Hero"
  width={800}
  height={400}
  priority
/>
\`\`\`

### 2. Caching
Use revalidate to control caching:

\`\`\`tsx
export const revalidate = 3600; // 1 hour
\`\`\`

### 3. Code Splitting
Use dynamic imports:

\`\`\`tsx
const HeavyComponent = dynamic(() => import('./HeavyComponent'), {
  loading: () => <Skeleton />,
});
\`\`\`

## Analysis Tools

### 1. Lighthouse
Use Lighthouse to analyze performance:

\`\`\`bash
npm run lighthouse
\`\`\`

### 2. Web Vitals
Track Core Web Vitals:

\`\`\`tsx
'use client';
import { useReportWebVitals } from 'next/web-vitals';

export function WebVitals() {
  useReportWebVitals((metric) => {
    console.log(metric);
  });
  return null;
}
\`\`\`

## Conclusion

Performance optimization is an ongoing process. Use these tips to improve your Next.js applications.`
    },
    date: '2023-12-28',
    author: {
      name: 'خالد عمر',
      avatar: 'https://ui-avatars.com/api/?name=Khaled+Omar&background=FF5722&color=fff'
    },
    coverImage: 'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=800&h=400&fit=crop',
    readTime: 5
  },
  {
    id: '6',
    slug: 'typescript-advanced-patterns',
    title: {
      ar: 'أنماط TypeScript المتقدمة',
      en: 'Advanced TypeScript Patterns'
    },
    excerpt: {
      ar: 'اكتشف أنماط TypeScript المتقدمة التي ستجعل كودك أكثر أمانًا وقابلية للصيانة.',
      en: 'Discover advanced TypeScript patterns that will make your code safer and more maintainable.'
    },
    content: {
      ar: `# أنماط TypeScript المتقدمة

TypeScript يوفر ميزات قوية لبناء أنواع معقدة وآمنة.

## الأنماط المتقدمة

### 1. Generic Types
استخدم الأنواع العامة لإعادة الاستخدام:

\`\`\`ts
interface ApiResponse<T> {
  data: T;
  status: number;
}

const response: ApiResponse<User> = {
  data: { name: 'John' },
  status: 200,
};
\`\`\`

### 2. Utility Types
استخدم أنواع TypeScript المساعدة:

\`\`\`ts
type PartialUser = Partial<User>;
type RequiredUser = Required<User>;
type UserKeys = keyof User;
\`\`\`

### 3. Conditional Types
استخدم الأنواع الشرطية:

\`\`\`ts
type NonNullable<T> = T extends null | undefined ? never : T;
\`\`\`

### 4. Mapped Types
استخدم الأنواع المعينة:

\`\`\`ts
type Readonly<T> = {
  readonly [P in keyof T]: T[P];
};
\`\`\`

## أفضل الممارسات

### 1. تجنب any
استخدم أنواع محددة بدلاً من any:

\`\`\`ts
// Bad
function processData(data: any) { }

// Good
function processData(data: UserData) { }
\`\`\`

### 2. Type Guards
استخدم Type Guards:

\`\`\`ts
function isString(value: unknown): value is string {
  return typeof value === 'string';
}
\`\`\`

## الخاتمة

TypeScript المتقدم يوفر أدوات قوية لبناء أنواع معقدة. استمر في التعلم والتجربة.`,
      en: `# Advanced TypeScript Patterns

TypeScript provides powerful features for building complex and safe types.

## Advanced Patterns

### 1. Generic Types
Use generics for reusability:

\`\`\`ts
interface ApiResponse<T> {
  data: T;
  status: number;
}

const response: ApiResponse<User> = {
  data: { name: 'John' },
  status: 200,
};
\`\`\`

### 2. Utility Types
Use TypeScript utility types:

\`\`\`ts
type PartialUser = Partial<User>;
type RequiredUser = Required<User>;
type UserKeys = keyof User;
\`\`\`

### 3. Conditional Types
Use conditional types:

\`\`\`ts
type NonNullable<T> = T extends null | undefined ? never : T;
\`\`\`

### 4. Mapped Types
Use mapped types:

\`\`\`ts
type Readonly<T> = {
  readonly [P in keyof T]: T[P];
};
\`\`\`

## Best Practices

### 1. Avoid any
Use specific types instead of any:

\`\`\`ts
// Bad
function processData(data: any) { }

// Good
function processData(data: UserData) { }
\`\`\`

### 2. Type Guards
Use type guards:

\`\`\`ts
function isString(value: unknown): value is string {
  return typeof value === 'string';
}
\`\`\`

## Conclusion

Advanced TypeScript provides powerful tools for building complex types. Keep learning and experimenting.`
    },
    date: '2023-12-20',
    author: {
      name: 'نورة السعيد',
      avatar: 'https://ui-avatars.com/api/?name=Noura+Al-Saeed&background=00BCD4&color=fff'
    },
    coverImage: 'https://images.unsplash.com/photo-1516116216624-53e697fedbea?w=800&h=400&fit=crop',
    readTime: 8
  }
];

export function getPostBySlug(slug: string): BlogPost | undefined {
  return blogPosts.find(post => post.slug === slug);
}

export function getAllPosts(): BlogPost[] {
  return blogPosts.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}
