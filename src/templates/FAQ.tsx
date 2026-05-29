import { useTranslations } from 'next-intl';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Section } from '@/features/landing/Section';

const faqs = [
  { questionKey: 'question1', answerKey: 'answer1' },
  { questionKey: 'question2', answerKey: 'answer2' },
  { questionKey: 'question3', answerKey: 'answer3' },
  { questionKey: 'question4', answerKey: 'answer4' },
  { questionKey: 'question5', answerKey: 'answer5' },
  { questionKey: 'question6', answerKey: 'answer6' },
] as const;

export const FAQ = () => {
  const t = useTranslations('FAQ');

  return (
    <Section id="faq">
      <Accordion type="multiple" className="w-full">
        {faqs.map(faq => (
          <AccordionItem key={faq.questionKey} value={faq.questionKey}>
            <AccordionTrigger>{t(faq.questionKey)}</AccordionTrigger>
            <AccordionContent>{t(faq.answerKey)}</AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </Section>
  );
};
