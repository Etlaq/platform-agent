'use client';

import Link from 'next/link';
import Image from 'next/image';
import { BlogPost } from '@/lib/blog-data';
import { useLanguage } from '@/contexts/LanguageContext';
import { Calendar, Clock, User } from 'lucide-react';
import { cn } from '@/lib/utils';

interface BlogCardProps {
  post: BlogPost;
  className?: string;
}

export function BlogCard({ post, className }: BlogCardProps) {
  const { isArabic } = useLanguage();

  return (
    <Link
      href={`/blog/${post.slug}`}
      className={cn(
        'group block overflow-hidden rounded-xl border border-border bg-card transition-all duration-300 hover:shadow-lg hover:border-primary/50',
        className
      )}
    >
      <div className="relative aspect-video overflow-hidden bg-muted">
        <Image
          src={post.coverImage}
          alt={isArabic ? post.title.ar : post.title.en}
          fill
          className="object-cover transition-transform duration-300 group-hover:scale-105"
          sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
        />
      </div>

      <div className="p-6 space-y-4">
        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <Calendar className="h-4 w-4" />
            <time dateTime={post.date}>
              {new Date(post.date).toLocaleDateString(isArabic ? 'ar-SA' : 'en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric'
              })}
            </time>
          </div>
          <div className="flex items-center gap-1.5">
            <Clock className="h-4 w-4" />
            <span>{post.readTime} {isArabic ? 'دقيقة' : 'min'}</span>
          </div>
        </div>

        <h3 className="text-xl font-semibold leading-tight group-hover:text-primary transition-colors">
          {isArabic ? post.title.ar : post.title.en}
        </h3>

        <p className="text-muted-foreground line-clamp-2">
          {isArabic ? post.excerpt.ar : post.excerpt.en}
        </p>

        <div className="flex items-center gap-2 pt-2 border-t border-border">
          <div className="flex items-center gap-2">
            {post.author.avatar ? (
              <Image
                src={post.author.avatar}
                alt={post.author.name}
                width={24}
                height={24}
                className="rounded-full"
              />
            ) : (
              <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center">
                <User className="h-3.5 w-3.5 text-primary" />
              </div>
            )}
            <span className="text-sm text-muted-foreground">{post.author.name}</span>
          </div>
        </div>
      </div>
    </Link>
  );
}
